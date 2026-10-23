// @vitest-environment node
import type { AuthData } from "@saleor/app-sdk/APL";
import { ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkoutQueryResponse,
  createdIntentFrom,
  ROUTE_SALEOR_API_URL,
  routeAuthData,
  signedInitializeRequest,
  transactionUpdateResponse,
} from "@/__tests__/mocks/initialize-route-harness";
import { mockedStripePaymentIntentsApi } from "@/__tests__/mocks/mocked-stripe-payment-intents-api";
import { FetchCheckoutPaymentStateWithLinesDocument } from "@/generated/graphql";

/*
 * Review of d462375c, item 11 (must fix before going live): the ROUTE wiring of A3d. With the
 * PayPal-fee gate on and PAYMENT_FEE_PAYPAL_CAPTURE unset (default "manual"), the real
 * transaction-initialize route creates paypal-only PaymentIntents with
 * payment_method_options.paypal.capture_method "manual"; card stays as the gate makes it.
 * The gate-off proof is route.gate-off.paypal-capture.test.ts (env is per file).
 */

const mocks = vi.hoisted(() => ({
  aplStore: new Map<string, AuthData>(),
  saleorQuery: vi.fn(),
  saleorMutation: vi.fn(),
}));

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

vi.mock("@/lib/graphql-client", () => ({
  createInstrumentedGraphqlClient: vi.fn(() => ({ query: mocks.saleorQuery, mutation: mocks.saleorMutation })),
}));

// Gate on, as on dess; PAYMENT_FEE_PAYPAL_CAPTURE unset: the default ("manual") applies.
vi.mock("@/lib/env", async () => {
  const original = await vi.importActual<typeof import("@/lib/env")>("@/lib/env");

  return {
    env: {
      ...original.env,
      PAYMENT_FEE_GATE: "paypal",
      PAYMENT_FEE_RATE_PERCENT: "1.5",
      PAYMENT_FEE_VARIANT_ID: "UHJvZHVjdFZhcmlhbnQ6NDQ5",
      PAYMENT_FEE_PAYPAL_CAPTURE: undefined,
    },
  };
});

import * as initializeSession from "./route";

const createCalls = () => vi.mocked(mockedStripePaymentIntentsApi.createPaymentIntent).mock.calls;

describe("POST transaction-initialize-session, gate on, PAYMENT_FEE_PAYPAL_CAPTURE default (A3d)", () => {
  beforeEach(() => {
    mocks.aplStore.clear();
    mocks.aplStore.set(ROUTE_SALEOR_API_URL, routeAuthData());
    mocks.saleorMutation.mockResolvedValue(transactionUpdateResponse());
    vi.mocked(mockedStripePaymentIntentsApi.searchPaymentIntentsByCheckout).mockResolvedValue(ok([]));
    vi.mocked(mockedStripePaymentIntentsApi.createPaymentIntent).mockImplementation(async (args) =>
      ok(createdIntentFrom(args)),
    );
  });

  it("creates the paypal-only PaymentIntent for a manual PayPal capture", async () => {
    mocks.saleorQuery.mockImplementation(() => checkoutQueryResponse({ withFee: true }));

    const response = await initializeSession.POST(
      signedInitializeRequest({
        paymentMethod: "paypal",
        amount: 101.5,
        idempotencyKey: "route-paypal",
        transactionId: "VHJhbnNhY3Rpb25JdGVtOm9uLXBheXBhbA==",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ pspReference: "pi_route_created" });
    expect(mocks.saleorQuery.mock.calls[0][0]).toBe(FetchCheckoutPaymentStateWithLinesDocument);
    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0][0].intentParams).toStrictEqual({
      payment_method_types: ["paypal"],
      payment_method_options: { paypal: { capture_method: "manual" } },
    });
    expect(createCalls()[0][0].metadata?.saleor_payment_policy).toBe("paypal-only");
  });

  it("leaves card (no-paypal) exactly as the gate makes it", async () => {
    mocks.saleorQuery.mockImplementation(() => checkoutQueryResponse({ withFee: false }));

    const response = await initializeSession.POST(
      signedInitializeRequest({
        paymentMethod: "card",
        amount: 100,
        idempotencyKey: "route-card",
        transactionId: "VHJhbnNhY3Rpb25JdGVtOm9uLWNhcmQ=",
      }),
    );

    expect(response.status).toBe(200);
    expect(createCalls()[0][0].intentParams).toStrictEqual({
      automatic_payment_methods: { enabled: true },
      excluded_payment_method_types: ["paypal"],
      payment_method_options: { card: { capture_method: undefined } },
    });
  });
});
