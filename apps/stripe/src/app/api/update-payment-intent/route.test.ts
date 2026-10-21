import { testApiHandler } from "next-test-api-route-handler";
import { ok } from "neverthrow";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockAuthData } from "@/__tests__/mocks/mock-auth-data";
import { mockedStripePaymentIntentsApi } from "@/__tests__/mocks/mocked-stripe-payment-intents-api";
import { mockedSaleorChannelId } from "@/__tests__/mocks/constants";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";

import * as updatePaymentIntentHandlers from "./route";

/*
 * Regression NR-02 (docs/plans/2026-10-21-platform-hardening-plan.md):
 * `/api/update-payment-intent` must never write an amount taken from the request
 * body, and must only touch a PaymentIntent that belongs to a live checkout.
 *
 * Boundaries mocked here: the APL (app installation), the config repo, the Stripe
 * PaymentIntents API and the Saleor GraphQL client. Everything in between is real.
 */

const { aplGet, saleorQuery } = vi.hoisted(() => ({
  aplGet: vi.fn(),
  saleorQuery: vi.fn(),
}));

vi.mock("@/lib/saleor-app", () => ({
  saleorApp: {
    apl: {
      get: aplGet,
    },
  },
}));

vi.mock("@/lib/graphql-client", () => ({
  createInstrumentedGraphqlClient: vi.fn(() => ({
    query: saleorQuery,
  })),
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
    StripePaymentIntentsApi: {
      createFromKey: () => mockedStripePaymentIntentsApi,
    },
  };
});

vi.mock("@/lib/env", async () => {
  const originalModule = await vi.importActual<typeof import("@/lib/env")>("@/lib/env");

  return {
    env: {
      ...originalModule.env,
      UPDATE_PAYMENT_INTENT_ALLOWED_ORIGINS: "https://shop.example.com",
    },
  };
});

const CHECKOUT_ID = "Q2hlY2tvdXQ6YWFhYWFhYWEtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAx";
const OTHER_CHECKOUT_ID = "Q2hlY2tvdXQ6YmJiYmJiYmItMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAy";
const TRANSACTION_ID = "VHJhbnNhY3Rpb25JdGVtOmNjY2NjY2NjLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMw==";
const PAYMENT_INTENT_ID = "pi_3NR02TestIntent";

const buildPaymentIntent = (overrides: Partial<Stripe.PaymentIntent> = {}) =>
  ({
    id: PAYMENT_INTENT_ID,
    object: "payment_intent",
    amount: 100_00,
    currency: "eur",
    status: "requires_payment_method",
    client_secret: `${PAYMENT_INTENT_ID}_secret_NR02`,
    metadata: {
      saleor_source_id: CHECKOUT_ID,
      saleor_source_type: "Checkout",
      saleor_transaction_id: TRANSACTION_ID,
    },
    ...overrides,
  }) as Stripe.PaymentIntent;

const money = (amount: number, currency = "EUR") => ({ amount, currency });

const ownTransaction = {
  id: TRANSACTION_ID,
  pspReference: PAYMENT_INTENT_ID,
  chargedAmount: money(0),
  authorizedAmount: money(0),
  chargePendingAmount: money(0),
  authorizePendingAmount: money(0),
};

const saleorCheckoutResponse = (args: {
  id?: string;
  total: number;
  transactions?: (typeof ownTransaction)[];
}) => ({
  toPromise: async () => ({
    data: {
      checkout: {
        id: args.id ?? CHECKOUT_ID,
        channel: { id: mockedSaleorChannelId },
        totalPrice: { gross: money(args.total) },
        transactions: args.transactions ?? [ownTransaction],
      },
    },
  }),
});

const requestBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    paymentIntentId: PAYMENT_INTENT_ID,
    amount: 103,
    currency: "EUR",
    channelId: mockedSaleorChannelId,
    saleorApiUrl: mockedSaleorApiUrl,
    ...overrides,
  });

const callRoute = async (body: string, headers: Record<string, string> = {}) => {
  let status = 0;
  let json: Record<string, unknown> = {};
  let responseHeaders = new Headers();

  await testApiHandler({
    appHandler: updatePaymentIntentHandlers,
    async test({ fetch }) {
      const response = await fetch({
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });

      status = response.status;
      responseHeaders = response.headers;
      json = await response.json();
    },
  });

  return { status, json, headers: responseHeaders };
};

const updateCalls = () => vi.mocked(mockedStripePaymentIntentsApi.updatePaymentIntent).mock.calls;

describe("POST /api/update-payment-intent (NR-02)", () => {
  beforeEach(() => {
    aplGet.mockResolvedValue(mockAuthData);
    vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent).mockResolvedValue(
      ok(buildPaymentIntent()),
    );
    vi.mocked(mockedStripePaymentIntentsApi.updatePaymentIntent).mockImplementation(
      async (args) =>
        ok(buildPaymentIntent({ amount: args.stripeMoney.amount, currency: args.stripeMoney.currency })),
    );
    saleorQuery.mockImplementation(() => saleorCheckoutResponse({ total: 103 }));
  });

  it("(a) never writes a client-supplied amount that is lower than the checkout total", async () => {
    const { status } = await callRoute(requestBody({ amount: 1 }));

    expect(updateCalls().some(([args]) => args.stripeMoney.amount === 1_00)).toBe(false);
    expect(status).toBe(200);
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0][0].stripeMoney.amount).toBe(103_00);
  });

  it("(b) rejects a PaymentIntent without saleor_source_id and does not update it", async () => {
    vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent).mockResolvedValue(
      ok(buildPaymentIntent({ metadata: {} })),
    );

    const { status } = await callRoute(requestBody());

    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(updateCalls()).toHaveLength(0);
  });

  it("(b) rejects a PaymentIntent that the referenced checkout does not hold", async () => {
    vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent).mockResolvedValue(
      ok(
        buildPaymentIntent({
          metadata: {
            saleor_source_id: OTHER_CHECKOUT_ID,
            saleor_source_type: "Checkout",
            saleor_transaction_id: "VHJhbnNhY3Rpb25JdGVtOm5vdC1vbi10aGlzLWNoZWNrb3V0",
          },
        }),
      ),
    );
    saleorQuery.mockImplementation(() =>
      saleorCheckoutResponse({
        id: OTHER_CHECKOUT_ID,
        total: 103,
        transactions: [
          {
            ...ownTransaction,
            id: "VHJhbnNhY3Rpb25JdGVtOnNvbWVvbmUtZWxzZQ==",
            pspReference: "pi_someone_else",
          },
        ],
      }),
    );

    const { status } = await callRoute(requestBody());

    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(updateCalls()).toHaveLength(0);
  });

  it("(c) rejects a currency that differs from the PaymentIntent currency", async () => {
    const { status } = await callRoute(requestBody({ currency: "USD" }));

    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(updateCalls()).toHaveLength(0);
  });

  it("(d) happy path: after the fee line is added, updates the PaymentIntent to the server total", async () => {
    const { status, json } = await callRoute(requestBody({ amount: 103 }));

    expect(status).toBe(200);
    expect(saleorQuery).toHaveBeenCalledOnce();
    expect(saleorQuery.mock.calls[0][1]).toStrictEqual({ checkoutId: CHECKOUT_ID });
    expect(saleorQuery.mock.calls[0][2]).toStrictEqual({ requestPolicy: "network-only" });
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0][0].id).toBe(PAYMENT_INTENT_ID);
    expect(updateCalls()[0][0].stripeMoney.amount).toBe(103_00);
    expect(updateCalls()[0][0].stripeMoney.currency).toBe("eur");
    expect(json).toStrictEqual({
      success: true,
      paymentIntentId: PAYMENT_INTENT_ID,
      amount: 103_00,
      currency: "eur",
    });
  });

  it("(e) returns 401 when the app is not installed for saleorApiUrl", async () => {
    aplGet.mockResolvedValue(undefined);

    const { status, json } = await callRoute(requestBody());

    expect(status).toBe(401);
    expect(json).toStrictEqual({ error: "App not installed for this Saleor instance" });
    expect(mockedStripePaymentIntentsApi.getPaymentIntent).not.toHaveBeenCalled();
    expect(updateCalls()).toHaveLength(0);
  });

  it("returns 400 when required fields are missing", async () => {
    const { status } = await callRoute(JSON.stringify({ paymentIntentId: PAYMENT_INTENT_ID }));

    expect(status).toBe(400);
    expect(updateCalls()).toHaveLength(0);
  });

  it("rejects a browser request from an origin that is not allowed", async () => {
    const { status, headers } = await callRoute(requestBody(), {
      origin: "https://evil.example.org",
    });

    expect(status).toBe(403);
    expect(headers.get("access-control-allow-origin")).toBeNull();
    expect(mockedStripePaymentIntentsApi.getPaymentIntent).not.toHaveBeenCalled();
    expect(updateCalls()).toHaveLength(0);
  });

  it("serves an allowed browser origin and echoes it in the CORS header", async () => {
    const { status, headers } = await callRoute(requestBody(), {
      origin: "https://shop.example.com",
    });

    expect(status).toBe(200);
    expect(headers.get("access-control-allow-origin")).toBe("https://shop.example.com");
  });
});
