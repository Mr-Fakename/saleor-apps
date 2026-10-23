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
import { FetchCheckoutPaymentStateDocument, TransactionUpdateDocument } from "@/generated/graphql";

/*
 * Review of d462375c, item 11: the gate-off route stays today's (SDS, rollback), even with a
 * stray PAYMENT_FEE_PAYPAL_CAPTURE=manual in the env: no capture option, no policy, today's
 * checkout query and today's single Saleor mutation.
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

// Gate off (SDS), with a stray capture mode that must have no effect.
vi.mock("@/lib/env", async () => {
  const original = await vi.importActual<typeof import("@/lib/env")>("@/lib/env");

  return {
    env: {
      ...original.env,
      PAYMENT_FEE_GATE: undefined,
      PAYMENT_FEE_RATE_PERCENT: undefined,
      PAYMENT_FEE_VARIANT_ID: undefined,
      PAYMENT_FEE_PAYPAL_CAPTURE: "manual",
    },
  };
});

import * as initializeSession from "./route";

const createCalls = () => vi.mocked(mockedStripePaymentIntentsApi.createPaymentIntent).mock.calls;

describe("POST transaction-initialize-session, gate off (A3d off-path proof)", () => {
  beforeEach(() => {
    mocks.aplStore.clear();
    mocks.aplStore.set(ROUTE_SALEOR_API_URL, routeAuthData());
    mocks.saleorQuery.mockImplementation(() => checkoutQueryResponse({ withFee: false }));
    mocks.saleorMutation.mockResolvedValue(transactionUpdateResponse());
    vi.mocked(mockedStripePaymentIntentsApi.searchPaymentIntentsByCheckout).mockResolvedValue(ok([]));
    vi.mocked(mockedStripePaymentIntentsApi.createPaymentIntent).mockImplementation(async (args) =>
      ok(createdIntentFrom(args)),
    );
  });

  it.each([
    {
      paymentMethod: "paypal" as const,
      transactionId: "VHJhbnNhY3Rpb25JdGVtOm9mZi1wYXlwYWw=",
      options: { paypal: { capture_method: undefined } },
    },
    {
      paymentMethod: "card" as const,
      transactionId: "VHJhbnNhY3Rpb25JdGVtOm9mZi1jYXJk",
      options: { card: { capture_method: undefined } },
    },
  ])("creates $paymentMethod PaymentIntents with today's params", async ({ paymentMethod, transactionId, options }) => {
    const response = await initializeSession.POST(
      signedInitializeRequest({ paymentMethod, amount: 100, idempotencyKey: `route-off-${paymentMethod}`, transactionId }),
    );

    expect(response.status).toBe(200);
    expect(mocks.saleorQuery.mock.calls[0][0]).toBe(FetchCheckoutPaymentStateDocument);
    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0][0].intentParams).toStrictEqual({
      automatic_payment_methods: { enabled: true },
      payment_method_options: options,
    });
    expect(createCalls()[0][0].metadata).toStrictEqual({
      saleor_source_id: "Q2hlY2tvdXQ6cm91dGUtdGVzdA==",
      saleor_source_type: "Checkout",
      saleor_transaction_id: transactionId,
    });
    expect(mocks.saleorMutation.mock.calls.map(([document]) => document)).toStrictEqual([TransactionUpdateDocument]);
  });
});
