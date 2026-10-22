import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import handler from "../../pages/api/payment-fee";
import { fakeSaleor, fakeUuid, toGlobalId } from "../mocks/fake-saleor";
import { createMockReq, createMockRes, errorMessageOf } from "../mocks/next-api";

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

const FEE_KEY = "payment_fee_type";
const FEE_VARIANT_ID = toGlobalId("ProductVariant", 449);
/** a fee variant an older PAYMENT_FEE_VARIANT_ID pointed to */
const OLD_FEE_VARIANT_ID = toGlobalId("ProductVariant", 448);
const PRODUCT_VARIANT_ID = toGlobalId("ProductVariant", 1);
const STOREFRONT = "https://dess-equipement.com";

const feeMetadata = (value = "paypal_1.5_percent") => [
  { key: FEE_KEY, value },
  { key: "display_name", value: "Service fee (1.5%)" },
];

/** 2 × 100.00 of product + 10.00 shipping = 210.00 fee-exclusive total */
function seedCheckout() {
  const checkout = fakeSaleor.addCheckout({ shipping: 10 });

  checkout.lines.push(fakeSaleor.newLine(PRODUCT_VARIANT_ID, 2, 100));

  return checkout;
}

async function callFee(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const req = createMockReq({ method: "POST", headers, body });
  const res = createMockRes();

  await handler(req, res);

  return res;
}

const feeLines = (checkoutId: string) => fakeSaleor.linesWithMetadataKey(checkoutId, FEE_KEY);

const recordOfMetadata = (metadata: Array<{ key: string; value: string }>) =>
  Object.fromEntries(metadata.map((m) => [m.key, m.value]));

describe("POST /api/payment-fee", () => {
  beforeEach(() => {
    fakeSaleor.reset();
    fakeSaleor.addVariant({
      id: FEE_VARIANT_ID,
      name: "PayPal fee",
      productName: "Service fee",
      productSlug: "service-fee",
      price: 0,
      currency: "EUR",
      attributes: [],
    });
    fakeSaleor.addVariant({
      id: PRODUCT_VARIANT_ID,
      name: "Amp",
      productName: "Amp",
      productSlug: "amp",
      price: 100,
      currency: "EUR",
      attributes: [],
    });
    vi.stubEnv("PAYMENT_FEE_VARIANT_ID", FEE_VARIANT_ID);
    vi.stubEnv("ALLOWED_ORIGINS", `${STOREFRONT},https://www.dess-equipement.com`);
    vi.stubEnv("PAYMENT_FEE_RATE_PERCENT", "");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("server-side fee amount", () => {
    it("ignores a caller-supplied amount and charges 1.5 % of the fee-exclusive total", async () => {
      const checkout = seedCheckout();

      const res = await callFee({
        checkoutId: checkout.id,
        apply: true,
        amount: 999,
        currency: "USD",
        ratePercent: 1.5,
      });

      expect(res._status).toBe(200);
      const lines = feeLines(checkout.id);

      expect(lines).toHaveLength(1);
      // 1.5 % × 210.00 = 3.15 — never the 999 the caller asked for
      expect(lines[0].unitPrice).toBe(3.15);
      expect(lines[0].quantity).toBe(1);
      expect(lines[0].variantId).toBe(FEE_VARIANT_ID);
      expect(lines[0].metadata).toContainEqual({ key: FEE_KEY, value: "paypal_1.5_percent" });
      // currency marker comes from the checkout, not the caller
      expect(lines[0].metadata).toContainEqual({ key: "currency", value: "EUR" });
    });

    it("applies the fee when the caller sends no amount at all", async () => {
      const checkout = seedCheckout();

      const res = await callFee({ checkoutId: checkout.id, apply: true });

      expect(res._status).toBe(200);
      expect(feeLines(checkout.id).map((l) => l.unitPrice)).toStrictEqual([3.15]);
    });

    it("uses the server rate from PAYMENT_FEE_RATE_PERCENT, not the caller's ratePercent", async () => {
      vi.stubEnv("PAYMENT_FEE_RATE_PERCENT", "2");
      const checkout = seedCheckout();

      const res = await callFee({ checkoutId: checkout.id, apply: true, amount: 0.01, ratePercent: 1.5 });

      expect(res._status).toBe(200);
      const lines = feeLines(checkout.id);

      expect(lines).toHaveLength(1);
      expect(lines[0].unitPrice).toBe(4.2); // 2 % × 210.00
      expect(lines[0].metadata).toContainEqual({ key: FEE_KEY, value: "paypal_2_percent" });
      expect(lines[0].metadata).toContainEqual({ key: "display_name", value: "Service fee (2%)" });
    });

    it.each(["abc", "0", "-1", "150"])(
      "fails closed with 500 when PAYMENT_FEE_RATE_PERCENT is invalid (%s)",
      async (rate) => {
        vi.stubEnv("PAYMENT_FEE_RATE_PERCENT", rate);
        const checkout = seedCheckout();

        const res = await callFee({ checkoutId: checkout.id, apply: true });

        expect(res._status).toBe(500);
        expect(fakeSaleor.mutationNames()).toStrictEqual([]);
      },
    );

    it("refuses to apply a fee to a checkout without a payable total", async () => {
      const checkout = fakeSaleor.addCheckout({ shipping: 0 });

      const res = await callFee({ checkoutId: checkout.id, apply: true });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });
  });

  describe("idempotency", () => {
    it("repeated apply calls never stack fee lines", async () => {
      const checkout = seedCheckout();

      await callFee({ checkoutId: checkout.id, apply: true, amount: 1 });
      await callFee({ checkoutId: checkout.id, apply: true, amount: 2 });
      const res = await callFee({ checkoutId: checkout.id, apply: true, amount: 3 });

      expect(res._status).toBe(200);
      expect(feeLines(checkout.id).map((l) => l.unitPrice)).toStrictEqual([3.15]);
      // the fee never feeds into its own base: total = 210.00 + 3.15
      expect(fakeSaleor.total(checkout)).toBe(213.15);
    });

    it("excludes an existing (stale) fee line from the base and replaces it", async () => {
      const checkout = seedCheckout();

      checkout.lines.push(fakeSaleor.newLine(FEE_VARIANT_ID, 1, 50, feeMetadata("paypal_2.9_percent")));

      const res = await callFee({ checkoutId: checkout.id, apply: true });

      expect(res._status).toBe(200);
      expect(feeLines(checkout.id).map((l) => l.unitPrice)).toStrictEqual([3.15]);
    });

    it("collapses pre-existing duplicate fee lines into exactly one", async () => {
      const checkout = seedCheckout();

      checkout.lines.push(fakeSaleor.newLine(FEE_VARIANT_ID, 1, 3.15, feeMetadata()));
      checkout.lines.push(fakeSaleor.newLine(FEE_VARIANT_ID, 1, 3.15, feeMetadata()));

      const res = await callFee({ checkoutId: checkout.id, apply: true });

      expect(res._status).toBe(200);
      expect(feeLines(checkout.id).map((l) => l.unitPrice)).toStrictEqual([3.15]);
    });

    it("converges to one fee line when a concurrent call added another meanwhile", async () => {
      const checkout = seedCheckout();

      fakeSaleor.beforeLinesAdd = (c) => {
        fakeSaleor.beforeLinesAdd = null;
        c.lines.push(fakeSaleor.newLine(FEE_VARIANT_ID, 1, 3.15, feeMetadata()));
      };

      const res = await callFee({ checkoutId: checkout.id, apply: true });

      expect(res._status).toBe(200);
      expect(feeLines(checkout.id)).toHaveLength(1);
    });

    it("apply=false removes every fee line", async () => {
      const checkout = seedCheckout();

      checkout.lines.push(fakeSaleor.newLine(FEE_VARIANT_ID, 1, 3.15, feeMetadata()));
      checkout.lines.push(fakeSaleor.newLine(FEE_VARIANT_ID, 1, 3.15, feeMetadata("paypal_2.9_percent")));

      const res = await callFee({ checkoutId: checkout.id, apply: false });

      expect(res._status).toBe(200);
      expect(feeLines(checkout.id)).toHaveLength(0);
      expect(checkout.lines).toHaveLength(1);
    });

    it("apply=false on a checkout without a fee is a no-op returning the checkout", async () => {
      const checkout = seedCheckout();

      const res = await callFee({ checkoutId: checkout.id, apply: false });

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({ checkout: { id: checkout.id } });
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });
  });

  describe("in-place fee-line update (A2c)", () => {
    // A delete-then-add leaves a moment with NO fee line, in which a concurrent
    // PaymentIntent resync can read a fee-less total. One checkoutLinesUpdate
    // changes the existing line atomically.

    it("fixes a single stale fee line with ONE checkoutLinesUpdate — no delete, no add", async () => {
      const checkout = seedCheckout();
      const stale = fakeSaleor.newLine(FEE_VARIANT_ID, 1, 2, feeMetadata());

      checkout.lines.push(stale);

      const res = await callFee({ checkoutId: checkout.id, apply: true });

      expect(res._status).toBe(200);
      expect(fakeSaleor.mutationNames()).toStrictEqual(["CheckoutLinesUpdate"]);
      expect(fakeSaleor.calls.find((c) => c.name === "CheckoutLinesUpdate")?.variables).toMatchObject({
        checkoutId: checkout.id,
        lines: [{ lineId: stale.id, price: "3.15", quantity: 1 }],
      });
      const lines = feeLines(checkout.id);

      expect(lines).toHaveLength(1);
      expect(lines[0].id).toBe(stale.id);
      expect(lines[0].unitPrice).toBe(3.15);
      expect(res._json).toMatchObject({ checkout: { id: checkout.id } });
    });

    it("an idempotent re-call after the update performs no mutation", async () => {
      const checkout = seedCheckout();

      checkout.lines.push(fakeSaleor.newLine(FEE_VARIANT_ID, 1, 2, feeMetadata()));
      await callFee({ checkoutId: checkout.id, apply: true });
      fakeSaleor.calls = [];

      const res = await callFee({ checkoutId: checkout.id, apply: true });

      expect(res._status).toBe(200);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
      expect(feeLines(checkout.id).map((l) => l.unitPrice)).toStrictEqual([3.15]);
    });

    it("refreshes a stale rate marker in the same single update", async () => {
      const checkout = seedCheckout();
      const stale = fakeSaleor.newLine(FEE_VARIANT_ID, 1, 6.09, feeMetadata("paypal_2.9_percent"));

      checkout.lines.push(stale);

      const res = await callFee({ checkoutId: checkout.id, apply: true });

      expect(res._status).toBe(200);
      expect(fakeSaleor.mutationNames()).toStrictEqual(["CheckoutLinesUpdate"]);
      const [line] = feeLines(checkout.id);

      expect(line.id).toBe(stale.id);
      expect(line.unitPrice).toBe(3.15);
      expect(recordOfMetadata(line.metadata)).toStrictEqual({
        [FEE_KEY]: "paypal_1.5_percent",
        display_name: "Service fee (1.5%)",
        currency: "EUR",
      });
    });

    it("resets a single fee line's quantity in the same update", async () => {
      const checkout = seedCheckout();

      checkout.lines.push(fakeSaleor.newLine(FEE_VARIANT_ID, 2, 3.15, feeMetadata()));

      const res = await callFee({ checkoutId: checkout.id, apply: true });

      expect(res._status).toBe(200);
      expect(fakeSaleor.mutationNames()).toStrictEqual(["CheckoutLinesUpdate"]);
      expect(feeLines(checkout.id).map((l) => [l.quantity, l.unitPrice])).toStrictEqual([[1, 3.15]]);
    });

    it("still replaces (delete + add) a single fee line that is not on the fee variant", async () => {
      const checkout = seedCheckout();

      checkout.lines.push(fakeSaleor.newLine(OLD_FEE_VARIANT_ID, 1, 3.15, feeMetadata()));

      const res = await callFee({ checkoutId: checkout.id, apply: true });

      expect(res._status).toBe(200);
      expect(fakeSaleor.mutationNames()).toStrictEqual(["CheckoutLinesDelete", "AddLinesToCheckout"]);
      expect(feeLines(checkout.id).map((l) => [l.variantId, l.unitPrice])).toStrictEqual([[FEE_VARIANT_ID, 3.15]]);
    });

    it("converges to one fee line when a concurrent call added one during the update", async () => {
      const checkout = seedCheckout();
      const stale = fakeSaleor.newLine(FEE_VARIANT_ID, 1, 2, feeMetadata());

      checkout.lines.push(stale);
      fakeSaleor.beforeLinesUpdate = (c) => {
        fakeSaleor.beforeLinesUpdate = null;
        c.lines.push(fakeSaleor.newLine(FEE_VARIANT_ID, 1, 3.15, feeMetadata()));
      };

      const res = await callFee({ checkoutId: checkout.id, apply: true });

      expect(res._status).toBe(200);
      expect(feeLines(checkout.id).map((l) => [l.id, l.unitPrice])).toStrictEqual([[stale.id, 3.15]]);
    });

    it("a failed update reports an error and leaves the existing fee line in place", async () => {
      const checkout = seedCheckout();
      const stale = fakeSaleor.newLine(FEE_VARIANT_ID, 1, 2, feeMetadata());

      checkout.lines.push(stale);
      fakeSaleor.failingOperations.add("CheckoutLinesUpdate");

      const res = await callFee({ checkoutId: checkout.id, apply: true });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual(["CheckoutLinesUpdate"]);
      expect(feeLines(checkout.id).map((l) => l.id)).toStrictEqual([stale.id]);
    });
  });

  describe("input validation", () => {
    it.each([
      ["string 'true' (form-encoded CSRF)", "true"],
      ["number 1", 1],
      ["missing", undefined],
    ])("rejects a non-boolean apply flag: %s", async (_label, apply) => {
      const checkout = seedCheckout();

      const res = await callFee({ checkoutId: checkout.id, apply, amount: 1 });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });

    it.each([
      ["garbage", "not-a-checkout-id"],
      ["another node type", toGlobalId("Order", fakeUuid())],
      ["non-uuid token", toGlobalId("Checkout", "1")],
      ["non-string", 42],
    ])("rejects a malformed checkoutId (%s) without calling Saleor", async (_label, checkoutId) => {
      const res = await callFee({ checkoutId, apply: true });

      expect(res._status).toBe(400);
      expect(fakeSaleor.calls).toStrictEqual([]);
    });

    it("returns 404 for an unknown (well-formed) checkout", async () => {
      const res = await callFee({ checkoutId: toGlobalId("Checkout", fakeUuid()), apply: true });

      expect(res._status).toBe(404);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });

    it("rejects methods other than POST/OPTIONS", async () => {
      const req = createMockReq({ method: "GET" });
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(405);
    });
  });

  describe("CORS / Origin allowlist", () => {
    it("rejects a preflight from a disallowed Origin with 403 and no allow-origin header", async () => {
      const req = createMockReq({ method: "OPTIONS", headers: { origin: "https://evil.example" } });
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(403);
      expect(res._headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("rejects a POST from a disallowed Origin without touching the checkout", async () => {
      const checkout = seedCheckout();

      const res = await callFee({ checkoutId: checkout.id, apply: true }, { origin: "https://evil.example" });

      expect(res._status).toBe(403);
      expect(res._headers["access-control-allow-origin"]).toBeUndefined();
      expect(errorMessageOf(res)).toMatch(/origin/i);
      expect(fakeSaleor.calls).toStrictEqual([]);
    });

    it("denies every cross-origin call when ALLOWED_ORIGINS is unset", async () => {
      vi.stubEnv("ALLOWED_ORIGINS", "");
      const checkout = seedCheckout();

      const res = await callFee({ checkoutId: checkout.id, apply: true }, { origin: STOREFRONT });

      expect(res._status).toBe(403);
      expect(res._headers["access-control-allow-origin"]).toBeUndefined();
      expect(fakeSaleor.calls).toStrictEqual([]);
    });

    it("answers an allowed Origin preflight with 204 and echoes that origin", async () => {
      const req = createMockReq({ method: "OPTIONS", headers: { origin: "https://www.dess-equipement.com" } });
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(204);
      expect(res._headers["access-control-allow-origin"]).toBe("https://www.dess-equipement.com");
      expect(res._headers["access-control-allow-methods"]).toContain("POST");
      expect(res._headers["access-control-allow-headers"]).toContain("Content-Type");
      expect(res._headers["vary"]).toContain("Origin");
    });

    it("applies the fee for an allowed Origin and echoes it", async () => {
      const checkout = seedCheckout();

      const res = await callFee({ checkoutId: checkout.id, apply: true }, { origin: STOREFRONT });

      expect(res._status).toBe(200);
      expect(res._headers["access-control-allow-origin"]).toBe(STOREFRONT);
      expect(feeLines(checkout.id)).toHaveLength(1);
    });

    it("serves server-to-server calls (no Origin header) without CORS headers", async () => {
      const checkout = seedCheckout();

      checkout.lines.push(fakeSaleor.newLine(FEE_VARIANT_ID, 1, 3.15, feeMetadata()));

      const res = await callFee({ checkoutId: checkout.id, apply: false });

      expect(res._status).toBe(200);
      expect(res._headers["access-control-allow-origin"]).toBeUndefined();
      expect(feeLines(checkout.id)).toHaveLength(0);
    });

    it("answers a bare OPTIONS probe (no Origin) with 204", async () => {
      const req = createMockReq({ method: "OPTIONS" });
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(204);
      expect(res._headers["access-control-allow-origin"]).toBeUndefined();
    });
  });
});
