import { testApiHandler } from "next-test-api-route-handler";
import { ok } from "neverthrow";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedSaleorChannelId } from "@/__tests__/mocks/constants";
import { mockAuthData } from "@/__tests__/mocks/mock-auth-data";
import { mockedStripePaymentIntentsApi } from "@/__tests__/mocks/mocked-stripe-payment-intents-api";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { FetchCheckoutPaymentStateWithLinesDocument } from "@/generated/graphql";

import * as updatePaymentIntentHandlers from "./route";

/*
 * A3c §1c: with the gate on (env), a refusal of /api/update-payment-intent carries a `code` the
 * storefront proxy passes through. Gate off, the body stays `{ error }` (see route.test.ts).
 */

const { aplGet, saleorQuery } = vi.hoisted(() => ({
  aplGet: vi.fn(),
  saleorQuery: vi.fn(),
}));

vi.mock("@/lib/saleor-app", () => ({
  saleorApp: { apl: { get: aplGet } },
}));

vi.mock("@/lib/graphql-client", () => ({
  createInstrumentedGraphqlClient: vi.fn(() => ({ query: saleorQuery })),
}));

vi.mock("@/modules/app-config/repositories/app-config-repo-impl", async () => {
  const { mockedAppConfigRepo } = await import("@/__tests__/mocks/app-config-repo");

  return { appConfigRepoImpl: mockedAppConfigRepo };
});

vi.mock("@/modules/stripe/stripe-payment-intents-api", async () => {
  const { mockedStripePaymentIntentsApi } = await import(
    "@/__tests__/mocks/mocked-stripe-payment-intents-api"
  );

  return {
    StripePaymentIntentsApi: { createFromKey: () => mockedStripePaymentIntentsApi },
  };
});

vi.mock("@/lib/env", async () => {
  const originalModule = await vi.importActual<typeof import("@/lib/env")>("@/lib/env");

  return {
    env: {
      ...originalModule.env,
      PAYMENT_FEE_GATE: "paypal",
      PAYMENT_FEE_RATE_PERCENT: "1.5",
      PAYMENT_FEE_VARIANT_ID: "UHJvZHVjdFZhcmlhbnQ6NDQ5",
    },
  };
});

const CHECKOUT_ID = "Q2hlY2tvdXQ6YWFhYWFhYWEtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAx";
const TRANSACTION_ID = "VHJhbnNhY3Rpb25JdGVtOmNjY2NjY2NjLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMw==";
const PAYMENT_INTENT_ID = "pi_3GateRouteIntent";

const money = (amount: number) => ({ amount, currency: "EUR" });

const paymentIntent = (metadata: Record<string, string>, fields: Partial<Stripe.PaymentIntent>) =>
  ({
    id: PAYMENT_INTENT_ID,
    object: "payment_intent",
    amount: 200_00,
    currency: "eur",
    status: "requires_payment_method",
    client_secret: `${PAYMENT_INTENT_ID}_secret_gate`,
    metadata: {
      saleor_source_id: CHECKOUT_ID,
      saleor_source_type: "Checkout",
      saleor_transaction_id: TRANSACTION_ID,
      ...metadata,
    },
    ...fields,
  }) as Stripe.PaymentIntent;

const paypalOnly = paymentIntent(
  { saleor_payment_policy: "paypal-only" },
  { payment_method_types: ["paypal"], excluded_payment_method_types: null, automatic_payment_methods: null },
);

const legacy = paymentIntent(
  {},
  {
    payment_method_types: ["card", "paypal"],
    excluded_payment_method_types: null,
    automatic_payment_methods: { enabled: true, allow_redirects: "always" },
  },
);

const checkoutResponse = (args: { total: number; feeAmount: number | null }) => ({
  toPromise: async () => ({
    data: {
      checkout: {
        id: CHECKOUT_ID,
        channel: { id: mockedSaleorChannelId },
        totalPrice: { gross: money(args.total) },
        transactions: [
          {
            id: TRANSACTION_ID,
            pspReference: PAYMENT_INTENT_ID,
            chargedAmount: money(0),
            authorizedAmount: money(0),
            chargePendingAmount: money(0),
            authorizePendingAmount: money(0),
            refundedAmount: money(0),
            refundPendingAmount: money(0),
            canceledAmount: money(0),
            cancelPendingAmount: money(0),
            events: [],
          },
        ],
        lines: [
          {
            id: "Q2hlY2tvdXRMaW5lOjE=",
            quantity: 1,
            variant: { id: "UHJvZHVjdFZhcmlhbnQ6MTI=" },
            metadata: [],
            totalPrice: { gross: money(210) },
          },
          ...(args.feeAmount === null
            ? []
            : [
                {
                  id: "Q2hlY2tvdXRMaW5lOjI=",
                  quantity: 1,
                  variant: { id: "UHJvZHVjdFZhcmlhbnQ6NDQ5" },
                  metadata: [{ key: "payment_fee_type", value: "paypal_1.5_percent" }],
                  totalPrice: { gross: money(args.feeAmount) },
                },
              ]),
        ],
      },
    },
  }),
});

const callRoute = async () => {
  let status = 0;
  let json: Record<string, unknown> = {};

  await testApiHandler({
    appHandler: updatePaymentIntentHandlers,
    async test({ fetch }) {
      const response = await fetch({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          paymentIntentId: PAYMENT_INTENT_ID,
          amount: 213.15,
          currency: "EUR",
          channelId: mockedSaleorChannelId,
          saleorApiUrl: mockedSaleorApiUrl,
        }),
      });

      status = response.status;
      json = await response.json();
    },
  });

  return { status, json };
};

const updateCalls = () => vi.mocked(mockedStripePaymentIntentsApi.updatePaymentIntent).mock.calls;

describe("POST /api/update-payment-intent with the PayPal-fee gate on (A3c)", () => {
  beforeEach(() => {
    aplGet.mockResolvedValue(mockAuthData);
    vi.mocked(mockedStripePaymentIntentsApi.updatePaymentIntent).mockImplementation(async (args) =>
      ok({ ...paypalOnly, amount: args.stripeMoney.amount }),
    );
  });

  it("reads the checkout with its lines and updates a paypal-only PaymentIntent to base + fee", async () => {
    vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent).mockResolvedValue(ok(paypalOnly));
    saleorQuery.mockImplementation(() => checkoutResponse({ total: 213.15, feeAmount: 3.15 }));

    const { status, json } = await callRoute();

    expect(status).toBe(200);
    expect(saleorQuery.mock.calls[0][0]).toBe(FetchCheckoutPaymentStateWithLinesDocument);
    expect(saleorQuery.mock.calls[0][1]).toStrictEqual({ checkoutId: CHECKOUT_ID });
    expect(json).toStrictEqual({
      success: true,
      paymentIntentId: PAYMENT_INTENT_ID,
      amount: 213_15,
      currency: "eur",
    });
  });

  it.each([
    { case: "a stale fee on a paypal-only PaymentIntent", pi: paypalOnly, fee: 3, code: "PAYMENT_FEE_STALE" },
    { case: "no fee on a paypal-only PaymentIntent", pi: paypalOnly, fee: null, code: "PAYMENT_FEE_REQUIRED" },
    { case: "a legacy PaymentIntent", pi: legacy, fee: 3.15, code: "PAYMENT_POLICY_REINIT" },
  ])("answers 409 with code $code for $case", async ({ pi, fee, code }) => {
    vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent).mockResolvedValue(ok(pi));
    saleorQuery.mockImplementation(() =>
      checkoutResponse({ total: 210 + (fee ?? 0), feeAmount: fee }),
    );

    const { status, json } = await callRoute();

    expect(status).toBe(409);
    expect(json).toStrictEqual({ error: expect.any(String), code });
    expect(updateCalls()).toHaveLength(0);
  });
});
