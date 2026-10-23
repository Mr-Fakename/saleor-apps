import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import handler from "../../pages/api/add-to-cart";
import { fakeSaleor, toGlobalId } from "../mocks/fake-saleor";
import { createMockReq, createMockRes } from "../mocks/next-api";

vi.mock("../../const", () => ({
  SALEOR_API_URL: "https://api.test/graphql/",
  DEFAULT_CHANNEL: "default-channel",
}));

vi.mock("../../saleor-app", () => ({
  apl: {
    get: async () => ({ token: "<app-token>", saleorApiUrl: "https://api.test/graphql/", appId: "app" }),
    getAll: async () => [],
  },
}));

vi.mock("../../lib/create-graphql-client", async () => {
  const { fakeSaleor: fake } = await import("../mocks/fake-saleor");

  return { createClient: () => fake.client };
});

const FEE_VARIANT = toGlobalId("ProductVariant", 449);
const PLAIN = toGlobalId("ProductVariant", 20);
const FEE_KEY = "payment_fee_type";

async function addToCart(body: Record<string, unknown>) {
  const req = createMockReq({ method: "POST", headers: {}, body });
  const res = createMockRes();

  await handler(req, res);

  return res;
}

describe("POST /api/add-to-cart — the payment-fee variant", () => {
  // Saleor merges checkoutLinesAdd (without forceNewLine) into the existing line of the same
  // variant and sets a given price on it IN PLACE. On the fee variant that would change the fee
  // line's price in place, which the Stripe app's own-price check cannot allow.
  beforeEach(() => {
    fakeSaleor.reset();
    fakeSaleor.addVariant({
      id: FEE_VARIANT,
      name: "PayPal fee",
      productName: "Service fee",
      productSlug: "service-fee",
      price: 0,
      currency: "EUR",
      attributes: [],
      quantityPricing: JSON.stringify({ "1": "0.5" }),
    });
    fakeSaleor.addVariant({
      id: PLAIN,
      name: "Amp",
      productName: "Amp",
      productSlug: "amp",
      price: 100,
      currency: "EUR",
      attributes: [],
    });
    vi.stubEnv("PAYMENT_FEE_VARIANT_ID", FEE_VARIANT);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses the fee variant without calling Saleor, so no fee line is ever priced here", async () => {
    const checkout = fakeSaleor.addCheckout({});
    const fee = fakeSaleor.newLine(FEE_VARIANT, 1, 3.15, [{ key: FEE_KEY, value: "paypal_1.5_percent" }]);

    checkout.lines.push(fee);

    const res = await addToCart({ checkoutId: checkout.id, variantId: FEE_VARIANT, quantity: 1 });

    expect(res._status).toBe(400);
    expect(fakeSaleor.calls).toStrictEqual([]);
    expect(checkout.lines.map((l) => [l.id, l.quantity, l.unitPrice])).toStrictEqual([[fee.id, 1, 3.15]]);
  });

  it("still adds an ordinary variant", async () => {
    const checkout = fakeSaleor.addCheckout({});

    const res = await addToCart({ checkoutId: checkout.id, variantId: PLAIN, quantity: 2 });

    expect(res._status).toBe(200);
    expect(checkout.lines.map((l) => [l.variantId, l.quantity])).toStrictEqual([[PLAIN, 2]]);
  });
});
