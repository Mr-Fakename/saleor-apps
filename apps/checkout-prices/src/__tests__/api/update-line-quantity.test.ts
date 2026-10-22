import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import handler from "../../pages/api/update-line-quantity";
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

const BASE = toGlobalId("ProductVariant", 10); // a "cable-custom" variant, catalog price 15.00
const OTHER_CABLE_PRODUCT_VARIANT = toGlobalId("ProductVariant", 12);
const PLAIN = toGlobalId("ProductVariant", 20); // an ordinary product with quantity tiers
const MARKER_KEY = "checkout_prices.cable_config";

/** Tiers that would reset a cable line to the catalog price of its base variant. */
const TIERS = JSON.stringify({ "1": "15", "10": "12" });

function seed() {
  const variant = (id: string, price: number, productSlug: string, quantityPricing: string | null = TIERS) =>
    fakeSaleor.addVariant({
      id,
      name: `variant ${id}`,
      productName: `product ${productSlug}`,
      productSlug,
      price,
      currency: "EUR",
      attributes: [],
      quantityPricing,
    });

  variant(BASE, 15, "cable-custom");
  variant(OTHER_CABLE_PRODUCT_VARIANT, 15, "something-else");
  variant(PLAIN, 100, "plain-product");
}

async function updateQuantity(checkoutId: string, lineId: string, quantity: number) {
  const req = createMockReq({ method: "POST", headers: {}, body: { checkoutId, lineId, quantity } });
  const res = createMockRes();

  await handler(req, res);

  return res;
}

describe("POST /api/update-line-quantity — configured cable lines (L4)", () => {
  beforeEach(() => {
    fakeSaleor.reset();
    seed();
    vi.stubEnv("CABLE_PRODUCT_SLUG", "");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps the app's custom price when a shopper deleted the public configurator_type key (cable product slug)", async () => {
    // Arrange — a 30.00 custom-priced cable whose public metadata was stripped
    const checkout = fakeSaleor.addCheckout({});
    const line = fakeSaleor.newLine(BASE, 1, 30, [{ key: "total_price", value: "30.00" }]);

    checkout.lines.push(line);

    // Act
    const res = await updateQuantity(checkout.id, line.id, 10);

    // Assert
    expect(res._status).toBe(200);
    expect(checkout.lines[0].quantity).toBe(10);
    expect(checkout.lines[0].unitPrice).toBe(30);
    expect(fakeSaleor.calls.map((c) => c.name)).not.toContain("GetVariantDetails");
  });

  it("recognises a line by the private marker alone, whatever its variant", async () => {
    // Arrange
    const checkout = fakeSaleor.addCheckout({});
    const line = fakeSaleor.newLine(OTHER_CABLE_PRODUCT_VARIANT, 1, 30, []);

    line.privateMetadata = [{ key: MARKER_KEY, value: '{"v":1,"metadata":{}}' }];
    checkout.lines.push(line);

    // Act
    const res = await updateQuantity(checkout.id, line.id, 10);

    // Assert
    expect(res._status).toBe(200);
    expect(checkout.lines[0].unitPrice).toBe(30);
    expect(fakeSaleor.calls.map((c) => c.name)).not.toContain("GetVariantDetails");
  });

  it("honours CABLE_PRODUCT_SLUG when deciding what a cable is", async () => {
    // Arrange
    vi.stubEnv("CABLE_PRODUCT_SLUG", "something-else");
    const checkout = fakeSaleor.addCheckout({});
    const line = fakeSaleor.newLine(OTHER_CABLE_PRODUCT_VARIANT, 1, 30, []);

    checkout.lines.push(line);

    // Act
    await updateQuantity(checkout.id, line.id, 10);

    // Assert
    expect(checkout.lines[0].unitPrice).toBe(30);
  });

  it("does not let a forged configurator_type key exempt an ordinary product from its quantity tiers", async () => {
    // Arrange — public metadata is shopper-writable in both directions
    const checkout = fakeSaleor.addCheckout({});
    const line = fakeSaleor.newLine(PLAIN, 1, 100, [{ key: "configurator_type", value: "cable" }]);

    checkout.lines.push(line);
    const plain = fakeSaleor.variants.get(PLAIN);

    if (plain) {
      plain.quantityPricing = JSON.stringify({ "1": "100", "10": "80" });
    }

    // Act
    await updateQuantity(checkout.id, line.id, 10);

    // Assert
    expect(checkout.lines[0].unitPrice).toBe(80);
  });
});
