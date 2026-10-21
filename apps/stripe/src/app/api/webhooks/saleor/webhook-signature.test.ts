// @vitest-environment node
/**
 * Regression NR-28: every money-moving Saleor webhook must reject a payload whose
 * `saleor-signature` does not verify against the registered Saleor's JWKS, BEFORE any
 * use case runs. TRANSACTION_REFUND_REQUESTED used to bypass verification entirely, so
 * anyone knowing a PaymentIntent id could make the app refund it in Stripe.
 *
 * Each test drives the real route (SDK SaleorSyncWebhook + the app's HttpsEnforcingAPL +
 * recipient check + use case). Only the outer boundaries are replaced: APL storage, the
 * Saleor JWKS endpoint (global fetch), the config repo, the transaction recorder and the
 * Stripe APIs. Signatures are real RS256 detached JWS, the format Saleor sends.
 */
import type { AuthData } from "@saleor/app-sdk/APL";
import { ok } from "neverthrow";
import { NextRequest } from "next/server";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockedAppToken, mockedSaleorAppId } from "@/__tests__/mocks/constants";
import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { mockedStripePaymentIntentsApi } from "@/__tests__/mocks/mocked-stripe-payment-intents-api";
import { mockedStripeRefundsApi } from "@/__tests__/mocks/mocked-stripe-refunds-api";
import { getMockedTransactionCancelationRequestedEvent } from "@/__tests__/mocks/saleor-events/transaction-cancelation-request-event";
import { getMockedTransactionChargeRequestedEvent } from "@/__tests__/mocks/saleor-events/transaction-charge-requested-event";
import { getMockedTransactionInitializeSessionEvent } from "@/__tests__/mocks/saleor-events/transaction-initialize-session-event";
import { getMockedTransactionProcessSessionEvent } from "@/__tests__/mocks/saleor-events/transaction-process-session-event";
import { getMockedTransactionRefundRequestedEvent } from "@/__tests__/mocks/saleor-events/transaction-refund-request-event";
import {
  createSaleorSigningKeys,
  signSaleorWebhookBody,
} from "@/__tests__/mocks/saleor-webhook-signature";

const mocks = vi.hoisted(() => ({
  aplStore: new Map<string, AuthData>(),
}));

// In-memory APL storage, wrapped by the app's real HttpsEnforcingAPL (as in src/lib/saleor-app.ts).
vi.mock("@/lib/saleor-app", async () => {
  const { HttpsEnforcingAPL } = await import("@/lib/https-enforcing-apl");

  const apl = new HttpsEnforcingAPL({
    get: async (saleorApiUrl) => mocks.aplStore.get(saleorApiUrl),
    set: async (authData) => {
      mocks.aplStore.set(authData.saleorApiUrl, authData);
    },
    delete: async (saleorApiUrl) => {
      mocks.aplStore.delete(saleorApiUrl);
    },
    getAll: async () => [...mocks.aplStore.values()],
  });

  return { apl, saleorApp: { apl } };
});

vi.mock("@/modules/app-config/repositories/app-config-repo-impl", async () => {
  const { mockedAppConfigRepo } = await import("@/__tests__/mocks/app-config-repo");

  return { appConfigRepoImpl: mockedAppConfigRepo };
});

vi.mock("@/modules/transactions-recording/repositories/transaction-recorder-impl", async () => {
  const { MockedTransactionRecorder } = await import("@/__tests__/mocks/mocked-transaction-recorder");

  return { transactionRecorder: new MockedTransactionRecorder() };
});

vi.mock("@/modules/stripe/stripe-payment-intents-api", async () => {
  const { mockedStripePaymentIntentsApi } = await import(
    "@/__tests__/mocks/mocked-stripe-payment-intents-api"
  );

  return { StripePaymentIntentsApi: { createFromKey: () => mockedStripePaymentIntentsApi } };
});

vi.mock("@/modules/stripe/stripe-refunds-api", async () => {
  const { mockedStripeRefundsApi } = await import("@/__tests__/mocks/mocked-stripe-refunds-api");

  return { StripeRefundsApi: { createFromKey: () => mockedStripeRefundsApi } };
});

import * as cancelationRequested from "./transaction-cancelation-requested/route";
import * as chargeRequested from "./transaction-charge-requested/route";
import * as initializeSession from "./transaction-initialize-session/route";
import * as processSession from "./transaction-process-session/route";
import * as refundRequested from "./transaction-refund-requested/route";

const REGISTERED_SALEOR_API_URL = "https://saleor-api.example.test/graphql/";
const REGISTERED_JWKS_URL = "https://saleor-api.example.test/.well-known/jwks.json";
const APP_HOST = "stripe.example.test";

const saleorKeys = createSaleorSigningKeys("saleor-kid");
// The attacker reuses Saleor's public kid with their own key.
const attackerKeys = createSaleorSigningKeys("saleor-kid");

const recipient = { id: mockedSaleorAppId };

const buildRequest = (args: {
  path: string;
  event: string;
  rawBody: string;
  signature?: string;
  saleorApiUrl?: string;
}) => {
  const headers = new Headers({
    "content-type": "application/json",
    host: APP_HOST,
    "x-forwarded-proto": "https",
    "saleor-api-url": args.saleorApiUrl ?? REGISTERED_SALEOR_API_URL,
    "saleor-event": args.event,
  });

  if (args.signature !== undefined) {
    headers.set("saleor-signature", args.signature);
  }

  return new NextRequest(`https://${APP_HOST}/api/webhooks/saleor/${args.path}`, {
    method: "POST",
    headers,
    body: args.rawBody,
  });
};

const jwksResponse = (jwks: string) =>
  new Response(jwks, { status: 200, headers: { "content-type": "application/json" } });

const stripeApiCalls = () => [
  ...mockedStripeRefundsApi.createRefund.mock.calls,
  ...mockedStripePaymentIntentsApi.createPaymentIntent.mock.calls,
  ...mockedStripePaymentIntentsApi.updatePaymentIntent.mock.calls,
  ...mockedStripePaymentIntentsApi.getPaymentIntent.mock.calls,
  ...mockedStripePaymentIntentsApi.capturePaymentIntent.mock.calls,
  ...mockedStripePaymentIntentsApi.cancelPaymentIntent.mock.calls,
  ...mockedStripePaymentIntentsApi.searchPaymentIntentsByCheckout.mock.calls,
];

const expectRejectedBeforeUseCase = async (response: Response) => {
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    error: { type: "SIGNATURE_VERIFICATION_FAILED" },
  });
  // The use case never ran: no config lookup, no Stripe call.
  expect(mockedAppConfigRepo.getStripeConfig).not.toHaveBeenCalled();
  expect(stripeApiCalls()).toHaveLength(0);
};

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  mocks.aplStore.clear();
  mocks.aplStore.set(REGISTERED_SALEOR_API_URL, {
    saleorApiUrl: REGISTERED_SALEOR_API_URL,
    appId: mockedSaleorAppId,
    token: mockedAppToken,
    jwks: saleorKeys.jwks,
  });

  // Saleor's JWKS endpoint, used by the SDK when the cached JWKS does not verify.
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => jwksResponse(saleorKeys.jwks));

  mockedStripeRefundsApi.createRefund.mockImplementation(async () =>
    ok({
      id: "re_NR28",
      amount: 100_00,
      currency: "usd",
      status: "succeeded",
    } as Stripe.Refund),
  );
});

describe("TRANSACTION_REFUND_REQUESTED signature verification (NR-28)", () => {
  const refundRequest = (rawBody: string, signature?: string, saleorApiUrl?: string) =>
    buildRequest({
      path: "transaction-refund-requested",
      event: "transaction_refund_requested",
      rawBody,
      signature,
      saleorApiUrl,
    });

  const refundBody = () => JSON.stringify({ ...getMockedTransactionRefundRequestedEvent(), recipient });

  it("rejects a payload signed with an attacker's key and never refunds", async () => {
    const rawBody = refundBody();

    const response = await refundRequested.POST(
      refundRequest(rawBody, signSaleorWebhookBody(rawBody, attackerKeys)),
    );

    await expectRejectedBeforeUseCase(response);
    expect(mockedStripeRefundsApi.createRefund).not.toHaveBeenCalled();
    // The second chance uses keys fetched from the REGISTERED Saleor, never from the request.
    expect(fetchSpy).toHaveBeenCalledWith(REGISTERED_JWKS_URL);
    expect(mocks.aplStore.get(REGISTERED_SALEOR_API_URL)?.jwks).toBe(saleorKeys.jwks);
  });

  it("rejects a garbage signature and never refunds", async () => {
    const response = await refundRequested.POST(refundRequest(refundBody(), "forged.signature.value"));

    await expectRejectedBeforeUseCase(response);
    expect(mockedStripeRefundsApi.createRefund).not.toHaveBeenCalled();
  });

  it("rejects a genuine signature replayed over a tampered body (higher amount)", async () => {
    const genuineBody = refundBody();
    const tamperedBody = JSON.stringify({
      ...getMockedTransactionRefundRequestedEvent(),
      recipient,
      action: { amount: 99999, currency: "USD" },
    });

    const response = await refundRequested.POST(
      refundRequest(tamperedBody, signSaleorWebhookBody(genuineBody, saleorKeys)),
    );

    await expectRejectedBeforeUseCase(response);
    expect(mockedStripeRefundsApi.createRefund).not.toHaveBeenCalled();
  });

  it("rejects a forged signature sent with the http:// form of the registered API URL", async () => {
    const rawBody = refundBody();

    const response = await refundRequested.POST(
      refundRequest(
        rawBody,
        signSaleorWebhookBody(rawBody, attackerKeys),
        "http://saleor-api.example.test/graphql/",
      ),
    );

    await expectRejectedBeforeUseCase(response);
    expect(fetchSpy).toHaveBeenCalledWith(REGISTERED_JWKS_URL);
  });

  it("rejects when the JWKS endpoint is unreachable and the cached JWKS does not verify", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));

    const rawBody = refundBody();

    const response = await refundRequested.POST(
      refundRequest(rawBody, signSaleorWebhookBody(rawBody, attackerKeys)),
    );

    await expectRejectedBeforeUseCase(response);
  });

  it("rejects a missing signature header with 400 and never refunds", async () => {
    const response = await refundRequested.POST(refundRequest(refundBody()));

    expect(response.status).toBe(400);
    expect(mockedStripeRefundsApi.createRefund).not.toHaveBeenCalled();
  });

  it("processes a payload with a valid Saleor signature (cached JWKS, no network)", async () => {
    const rawBody = refundBody();

    const response = await refundRequested.POST(
      refundRequest(rawBody, signSaleorWebhookBody(rawBody, saleorKeys)),
    );

    expect(response.status).toBe(200);
    // The app answers with the PaymentIntent id as pspReference (see use-case-response.ts).
    await expect(response.json()).resolves.toStrictEqual({
      pspReference: mockedStripePaymentIntentId,
    });
    expect(mockedStripeRefundsApi.createRefund).toHaveBeenCalledOnce();
    expect(mockedStripeRefundsApi.createRefund.mock.calls[0][0].paymentIntentId).toBe(
      mockedStripePaymentIntentId,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("processes a valid signature sent with the http:// form of the registered API URL", async () => {
    // The old bypass blamed a "JWKS issue" on http:// URLs; HttpsEnforcingAPL folds the scheme.
    const rawBody = refundBody();

    const response = await refundRequested.POST(
      refundRequest(
        rawBody,
        signSaleorWebhookBody(rawBody, saleorKeys),
        "http://saleor-api.example.test/graphql/",
      ),
    );

    expect(response.status).toBe(200);
    expect(mockedStripeRefundsApi.createRefund).toHaveBeenCalledOnce();
  });

  it("refreshes a stale cached JWKS from the registered Saleor, then processes", async () => {
    mocks.aplStore.set(REGISTERED_SALEOR_API_URL, {
      saleorApiUrl: REGISTERED_SALEOR_API_URL,
      appId: mockedSaleorAppId,
      token: mockedAppToken,
      jwks: createSaleorSigningKeys("rotated-out-kid").jwks,
    });

    const rawBody = refundBody();

    const response = await refundRequested.POST(
      refundRequest(rawBody, signSaleorWebhookBody(rawBody, saleorKeys)),
    );

    expect(response.status).toBe(200);
    expect(mockedStripeRefundsApi.createRefund).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(REGISTERED_JWKS_URL);
    expect(mocks.aplStore.get(REGISTERED_SALEOR_API_URL)?.jwks).toBe(saleorKeys.jwks);
  });
});

describe("Other money-moving Saleor webhooks reject forged signatures (NR-28)", () => {
  it.each([
    {
      name: "TRANSACTION_CHARGE_REQUESTED",
      route: chargeRequested,
      path: "transaction-charge-requested",
      event: "transaction_charge_requested",
      payload: () => ({ ...getMockedTransactionChargeRequestedEvent(), recipient }),
    },
    {
      name: "TRANSACTION_CANCELATION_REQUESTED",
      route: cancelationRequested,
      path: "transaction-cancelation-requested",
      event: "transaction_cancelation_requested",
      payload: () => ({ ...getMockedTransactionCancelationRequestedEvent(), recipient }),
    },
    {
      name: "TRANSACTION_PROCESS_SESSION",
      route: processSession,
      path: "transaction-process-session",
      event: "transaction_process_session",
      payload: () => ({ ...getMockedTransactionProcessSessionEvent(), recipient }),
    },
    {
      name: "TRANSACTION_INITIALIZE_SESSION",
      route: initializeSession,
      path: "transaction-initialize-session",
      event: "transaction_initialize_session",
      payload: () => ({ ...getMockedTransactionInitializeSessionEvent(), recipient }),
    },
  ])("$name rejects an attacker-signed payload before the use case", async (testCase) => {
    const rawBody = JSON.stringify(testCase.payload());

    const response = await testCase.route.POST(
      buildRequest({
        path: testCase.path,
        event: testCase.event,
        rawBody,
        signature: signSaleorWebhookBody(rawBody, attackerKeys),
      }),
    );

    await expectRejectedBeforeUseCase(response);
  });
});
