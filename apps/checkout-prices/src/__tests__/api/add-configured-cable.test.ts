import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import handler from "../../pages/api/add-configured-cable";
import { fakeSaleor, fakeUuid, toGlobalId } from "../mocks/fake-saleor";
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

const pv = (n: number) => toGlobalId("ProductVariant", n);
const product = (n: number) => toGlobalId("Product", n);

const BASE = pv(10); // a "cable-custom" variant (assembly fee 15.00)
const BASE_Y = pv(11); // a "cable-custom" Y/Insert variant (offers connector 3) — 20.00
const CONNECTOR_A = pv(101); // default variant of connector product 100 — 5.00
const CONNECTOR_B = pv(111); // default variant of connector product 110 — 7.00
const CONNECTOR_C = pv(105); // referenced directly as a variant — 4.00
const CABLE = pv(201); // default variant of cable product 200 — 2.00 €/m
const GAINE = pv(301); // referenced directly as a variant — 1.00 €/m
const UNPRICED_CONNECTOR = pv(121); // default variant of product 120 — no channel price
const AMPLIFIER = pv(999); // an expensive product that is NOT the cable product
const SCREW = pv(998); // a cheap variant not offered by the cable

function seedCatalog() {
  const variant = (
    id: string,
    price: number | null,
    productSlug: string,
    attributes: Array<{ slug: string; references: string[] }> = [],
  ) =>
    fakeSaleor.addVariant({
      id,
      name: `variant ${id}`,
      productName: `product ${productSlug}`,
      productSlug,
      price,
      currency: "EUR",
      attributes,
    });

  variant(BASE, 15, "cable-custom", [
    { slug: "connecteur-1", references: [product(100), CONNECTOR_C, product(120)] },
    { slug: "connecteur-2", references: [product(100), product(110)] },
    { slug: "reference-cable", references: [product(200)] },
    { slug: "reference-gaine", references: [GAINE] },
  ]);
  variant(BASE_Y, 20, "cable-custom", [
    { slug: "connecteur-1", references: [product(100)] },
    { slug: "connecteur-2", references: [product(110)] },
    { slug: "connecteur-3", references: [CONNECTOR_C] },
    { slug: "reference-cable", references: [product(200)] },
  ]);
  variant(CONNECTOR_A, 5, "connector-a");
  variant(CONNECTOR_B, 7, "connector-b");
  variant(CONNECTOR_C, 4, "connector-c");
  variant(UNPRICED_CONNECTOR, null, "connector-unpriced");
  variant(CABLE, 2, "cable-core");
  variant(GAINE, 1, "gaine");
  variant(AMPLIFIER, 1500, "amplifier");
  variant(SCREW, 0.1, "vis");

  fakeSaleor.addProduct({ id: product(100), defaultVariantId: CONNECTOR_A });
  fakeSaleor.addProduct({ id: product(110), defaultVariantId: CONNECTOR_B });
  fakeSaleor.addProduct({ id: product(120), defaultVariantId: UNPRICED_CONNECTOR });
  fakeSaleor.addProduct({ id: product(200), defaultVariantId: CABLE });
}

function validConfiguration(overrides: Record<string, unknown> = {}) {
  return {
    connecteur1Id: CONNECTOR_A,
    connecteur2Id: CONNECTOR_B,
    connecteur3Id: null,
    typeCableId: CABLE,
    referenceGaineId: GAINE,
    directionCableId: toGlobalId("AttributeValue", 7),
    longueurCable: 100,
    variantName: "Standard",
    connecteur1Name: "Jack A",
    connecteur2Name: "Jack B",
    connecteur3Name: "Non sélectionné",
    typeCableName: "Câble",
    referenceGaineName: "Gaine",
    directionCableName: "Droit",
    longueurCableName: "100cm",
    // caller-side estimate — must never be what we charge
    totalPrice: 0.01,
    currency: "EUR",
    configFingerprint: "0123456789abcdef",
    ...overrides,
  };
}

async function callCable(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const req = createMockReq({ method: "POST", headers, body });
  const res = createMockRes();

  await handler(req, res);

  return res;
}

const cableLines = (checkoutId: string) => fakeSaleor.linesWithMetadataKey(checkoutId, "configurator_type");

const metaValue = (metadata: Array<{ key: string; value: string }>, key: string) =>
  metadata.find((m) => m.key === key)?.value;

describe("POST /api/add-configured-cable", () => {
  let checkoutId: string;

  beforeEach(() => {
    fakeSaleor.reset();
    seedCatalog();
    checkoutId = fakeSaleor.addCheckout({}).id;
    vi.stubEnv("ALLOWED_ORIGINS", "https://dess-equipement.com");
    vi.stubEnv("CABLE_MIN_LENGTH_CM", "");
    vi.stubEnv("CABLE_MAX_LENGTH_CM", "");
    vi.stubEnv("CABLE_PRODUCT_SLUG", "");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("cable length", () => {
    it.each([
      ["negative", -5],
      ["zero", 0],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["way above the maximum", 999999],
      ["just below the minimum (10 cm)", 9.99],
      ["just above the maximum (5000 cm)", 5000.01],
      ["a numeric string", "100"],
      ["missing", undefined],
    ])("rejects a %s length without touching the checkout", async (_label, longueurCable) => {
      const res = await callCable({
        checkoutId,
        baseVariantId: BASE,
        quantity: 1,
        configuration: validConfiguration({ longueurCable }),
      });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
      expect(cableLines(checkoutId)).toHaveLength(0);
    });

    it.each([10, 100, 12.5, 5000])("accepts a valid length of %s cm", async (longueurCable) => {
      const res = await callCable({
        checkoutId,
        baseVariantId: BASE,
        quantity: 1,
        configuration: validConfiguration({ longueurCable }),
      });

      expect(res._status).toBe(200);
      expect(cableLines(checkoutId)).toHaveLength(1);
    });

    it("takes the bounds from CABLE_MIN_LENGTH_CM / CABLE_MAX_LENGTH_CM", async () => {
      vi.stubEnv("CABLE_MAX_LENGTH_CM", "200");

      const tooLong = await callCable({
        checkoutId,
        baseVariantId: BASE,
        configuration: validConfiguration({ longueurCable: 300 }),
      });

      expect(tooLong._status).toBe(400);

      const ok = await callCable({
        checkoutId,
        baseVariantId: BASE,
        configuration: validConfiguration({ longueurCable: 200 }),
      });

      expect(ok._status).toBe(200);
    });
  });

  describe("server-side pricing", () => {
    it("prices a valid 100 cm cable from Saleor, ignoring the caller's totalPrice", async () => {
      const res = await callCable({
        checkoutId,
        baseVariantId: BASE,
        quantity: 2,
        configuration: validConfiguration(),
      });

      expect(res._status).toBe(200);
      const lines = cableLines(checkoutId);

      expect(lines).toHaveLength(1);
      // 15 assembly + 5 + 7 connectors + 1.00 €/m gaine × 1 m + 2.00 €/m cable × 1 m
      expect(lines[0].unitPrice).toBe(30);
      expect(lines[0].quantity).toBe(2);
      expect(lines[0].variantId).toBe(BASE);
      expect(metaValue(lines[0].metadata, "total_price")).toBe("30.00");
      expect(metaValue(lines[0].metadata, "longueur_cable_cm")).toBe("100");
      expect(metaValue(lines[0].metadata, "component_gaine_price")).toBe("1.00");
      expect(metaValue(lines[0].metadata, "component_gaine_per_meter_price")).toBe("1.00");
      expect(metaValue(lines[0].metadata, "component_length_price")).toBe("2.00");
      expect(metaValue(lines[0].metadata, "config_fingerprint")).toBe("0123456789abcdef");
    });

    it("accepts a connector referenced directly as a variant", async () => {
      const res = await callCable({
        checkoutId,
        baseVariantId: BASE,
        configuration: validConfiguration({ connecteur1Id: CONNECTOR_C, referenceGaineId: null }),
      });

      expect(res._status).toBe(200);
      // 15 + 4 + 7 + 2.00 cable, no gaine
      expect(cableLines(checkoutId)[0].unitPrice).toBe(28);
    });

    it("refuses a base variant that is not the configurable cable product", async () => {
      const res = await callCable({
        checkoutId,
        baseVariantId: AMPLIFIER,
        configuration: validConfiguration(),
      });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });

    it.each([
      ["connecteur1Id", SCREW],
      ["connecteur2Id", CONNECTOR_C], // offered for slot 1 only
      ["typeCableId", CONNECTOR_A],
      ["referenceGaineId", SCREW],
      ["connecteur3Id", CONNECTOR_A], // the base variant has no connector-3 slot
    ])("refuses a %s the base variant does not offer", async (field, value) => {
      const res = await callCable({
        checkoutId,
        baseVariantId: BASE,
        configuration: validConfiguration({ [field]: value }),
      });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });

    it("requires connector 3 on a Y/Insert variant and prices it when given", async () => {
      const missing = await callCable({
        checkoutId,
        baseVariantId: BASE_Y,
        configuration: validConfiguration({ referenceGaineId: null }),
      });

      expect(missing._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);

      const given = await callCable({
        checkoutId,
        baseVariantId: BASE_Y,
        configuration: validConfiguration({
          referenceGaineId: null,
          connecteur3Id: CONNECTOR_C,
          connecteur3Name: "Jack C",
        }),
      });

      expect(given._status).toBe(200);
      const [line] = cableLines(checkoutId);

      // 20 assembly + 5 + 7 + 4 connectors + 2.00 cable × 1 m
      expect(line.unitPrice).toBe(38);
      expect(metaValue(line.metadata, "connecteur_3_id")).toBe(CONNECTOR_C);
      expect(metaValue(line.metadata, "connecteur_3_name")).toBe("Jack C");
      expect(metaValue(line.metadata, "component_connector3_price")).toBe("4.00");
    });

    it("refuses a component that has no price in the channel (never prices it at 0)", async () => {
      const res = await callCable({
        checkoutId,
        baseVariantId: BASE,
        configuration: validConfiguration({ connecteur1Id: UNPRICED_CONNECTOR }),
      });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });

    it.each([0, -1, 1.5, 1000, "2"])("rejects quantity %s", async (quantity) => {
      const res = await callCable({
        checkoutId,
        baseVariantId: BASE,
        quantity,
        configuration: validConfiguration(),
      });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });
  });

  describe("checkout ownership / identity", () => {
    it("rejects a malformed checkoutId without calling Saleor", async () => {
      const res = await callCable({
        checkoutId: "Q2hlY2tvdXQ6MQ==", // "Checkout:1" — not a checkout token
        baseVariantId: BASE,
        configuration: validConfiguration(),
      });

      expect(res._status).toBe(400);
      expect(fakeSaleor.calls).toStrictEqual([]);
    });

    it("rejects a checkout from another channel (prices are channel-specific)", async () => {
      const foreign = fakeSaleor.addCheckout({ channelSlug: "other-channel" });

      const res = await callCable({
        checkoutId: foreign.id,
        baseVariantId: BASE,
        configuration: validConfiguration(),
      });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });

    it("returns 400 for an unknown (well-formed) checkout", async () => {
      const res = await callCable({
        checkoutId: toGlobalId("Checkout", fakeUuid()),
        baseVariantId: BASE,
        configuration: validConfiguration(),
      });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });
  });

  describe("CORS / Origin allowlist", () => {
    it("rejects a call from a disallowed Origin without touching Saleor", async () => {
      const res = await callCable(
        { checkoutId, baseVariantId: BASE, configuration: validConfiguration() },
        { origin: "https://evil.example" },
      );

      expect(res._status).toBe(403);
      expect(res._headers["access-control-allow-origin"]).toBeUndefined();
      expect(fakeSaleor.calls).toStrictEqual([]);
    });

    it("serves the storefront server action (no Origin header)", async () => {
      const res = await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });

      expect(res._status).toBe(200);
      expect(res._headers["access-control-allow-origin"]).toBeUndefined();
    });
  });
});
