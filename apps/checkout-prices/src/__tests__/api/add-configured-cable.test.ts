import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import handler from "../../pages/api/add-configured-cable";
import { type FakeLine, fakeSaleor, fakeUuid, toGlobalId } from "../mocks/fake-saleor";
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
const DIRECTION_DROIT = toGlobalId("AttributeValue", 7);
const DIRECTION_COUDE = toGlobalId("AttributeValue", 8);
const DIRECTION_OTHER = toGlobalId("AttributeValue", 9); // a value of ANOTHER attribute (slug "direction")

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
    { slug: "direction-cable", references: [] },
    { slug: "connecteur-1", references: [product(100), CONNECTOR_C, product(120)] },
    { slug: "connecteur-2", references: [product(100), product(110)] },
    { slug: "reference-cable", references: [product(200)] },
    { slug: "reference-gaine", references: [GAINE] },
  ]);
  variant(BASE_Y, 20, "cable-custom", [
    { slug: "direction-cable", references: [] },
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
  fakeSaleor.addAttribute({ slug: "direction", choices: [{ id: DIRECTION_OTHER, name: "Autre" }] });
  // the cable direction attribute the storefront offers (candidate slug "direction-cable")
  fakeSaleor.addAttribute({
    slug: "direction-cable",
    choices: [
      { id: DIRECTION_DROIT, name: "Droit" },
      { id: DIRECTION_COUDE, name: "Coudé" },
    ],
  });
}

// Saleor's own labels (storefront rule: a product reference shows the PRODUCT name, a variant
// reference the VARIANT name; translation first, base name as fallback)
const SALEOR_NAMES = {
  variantName: `variant ${BASE}`,
  connecteur1Name: "product connector-a",
  connecteur2Name: "product connector-b",
  connecteur3Name: `variant ${CONNECTOR_C}`,
  typeCableName: "product cable-core",
  referenceGaineName: `variant ${GAINE}`,
};

function validConfiguration(overrides: Record<string, unknown> = {}) {
  return {
    connecteur1Id: CONNECTOR_A,
    connecteur2Id: CONNECTOR_B,
    connecteur3Id: null,
    typeCableId: CABLE,
    referenceGaineId: GAINE,
    directionCableId: DIRECTION_DROIT,
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

// NR-33 contract keys (pinned by src/__tests__/cable-line-marker.test.ts)
const MARKER_KEY = "checkout_prices.cable_config";
const REF_KEY = "cable_line_ref";
const MARKER_WRITE_FAILED_LOG = "[add-configured-cable] cable_marker_write_failed";
const MARKER_LINE_NOT_FOUND_LOG = "[add-configured-cable] cable_marker_line_not_found";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const markerOf = (line: FakeLine) => metaValue(line.privateMetadata, MARKER_KEY);

const recordOf = (metadata: Array<{ key: string; value: string }>) =>
  Object.fromEntries(metadata.map((m) => [m.key, m.value]));

/** The marker's recorded metadata without the per-line reference. */
function recordedConfiguration(line: FakeLine): Record<string, string> {
  const marker = markerOf(line);

  if (marker === undefined) {
    throw new Error("line has no marker");
  }
  const { metadata } = JSON.parse(marker) as { metadata: Record<string, string> };
  const { [REF_KEY]: _ref, ...rest } = metadata;

  return rest;
}

const changedKeys = (a: Record<string, string>, b: Record<string, string>) =>
  Array.from(new Set([...Object.keys(a), ...Object.keys(b)]))
    .filter((key) => a[key] !== b[key])
    .sort();

/** Line metadata of the checkoutLinesAdd the handler is executing right now. */
function incomingLineMetadata(): Array<{ key: string; value: string }> {
  const lines = fakeSaleor.calls[fakeSaleor.calls.length - 1]?.variables.lines;

  if (!Array.isArray(lines) || lines.length !== 1) {
    throw new Error("expected one incoming line");
  }

  return (lines[0] as { metadata: Array<{ key: string; value: string }> }).metadata;
}

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
      expect(metaValue(line.metadata, "connecteur_3_name")).toBe(SALEOR_NAMES.connecteur3Name);
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

  describe("verification marker (NR-33)", () => {
    it("writes a PRIVATE marker holding exactly the line's public cable metadata", async () => {
      const res = await callCable({
        checkoutId,
        baseVariantId: BASE,
        quantity: 2,
        configuration: validConfiguration(),
      });

      expect(res._status).toBe(200);
      const [line] = cableLines(checkoutId);

      expect(metaValue(line.metadata, REF_KEY)).toMatch(UUID_V4);
      const marker = markerOf(line);

      expect(marker).toBeDefined();
      expect(JSON.parse(marker ?? "null")).toStrictEqual({ v: 1, metadata: recordOf(line.metadata) });
      // written on that very line, after it exists, with the app token
      expect(fakeSaleor.mutationNames()).toStrictEqual(["AddLinesToCheckout", "CableLineMarker"]);
      expect(fakeSaleor.calls[fakeSaleor.calls.length - 1].variables).toMatchObject({ id: line.id });
      // never in the PUBLIC metadata, which any API client can rewrite
      expect(metaValue(line.metadata, MARKER_KEY)).toBeUndefined();
    });

    it("marks the line of a newly created checkout too", async () => {
      const res = await callCable({ baseVariantId: BASE, configuration: validConfiguration() });

      expect(res._status).toBe(200);
      const created = Array.from(fakeSaleor.checkouts.values()).find((c) => c.id !== checkoutId);
      const [line] = cableLines(created?.id ?? "");

      expect(fakeSaleor.mutationNames()).toStrictEqual(["CreateExampleCheckout", "CableLineMarker"]);
      expect(JSON.parse(markerOf(line) ?? "null")).toStrictEqual({ v: 1, metadata: recordOf(line.metadata) });
    });

    it("the marker changes when any priced field changes", async () => {
      const add = async (overrides: Record<string, unknown>) => {
        const target = fakeSaleor.addCheckout({}).id;
        const res = await callCable({
          checkoutId: target,
          baseVariantId: BASE,
          configuration: validConfiguration(overrides),
        });

        expect(res._status).toBe(200);

        return recordedConfiguration(cableLines(target)[0]);
      };

      const reference = await add({});

      // control: the same configuration records the same priced fields
      expect(await add({})).toStrictEqual(reference);
      // 100 cm -> 200 cm: length, cable × length, sleeve × length and the total
      expect(changedKeys(reference, await add({ longueurCable: 200 }))).toStrictEqual([
        "component_gaine_price",
        "component_length_price",
        "longueur_cable_cm",
        "longueur_cable_name",
        "total_price",
      ]);
      // another connector option (4.00 instead of 5.00)
      expect(changedKeys(reference, await add({ connecteur1Id: CONNECTOR_C }))).toStrictEqual([
        "component_connector1_price",
        "connecteur_1_id",
        "connecteur_1_name",
        "total_price",
      ]);
      // no sleeve
      expect(changedKeys(reference, await add({ referenceGaineId: null, referenceGaineName: null }))).toStrictEqual([
        "component_gaine_per_meter_price",
        "component_gaine_price",
        "reference_gaine_id",
        "reference_gaine_name",
        "total_price",
      ]);
    });

    it("gives each add its own line reference, so identical cables are marked separately", async () => {
      await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });
      await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });

      const lines = cableLines(checkoutId);

      expect(lines).toHaveLength(2);
      expect(metaValue(lines[0].metadata, REF_KEY)).not.toBe(metaValue(lines[1].metadata, REF_KEY));
      for (const line of lines) {
        expect(JSON.parse(markerOf(line) ?? "null")).toStrictEqual({ v: 1, metadata: recordOf(line.metadata) });
      }
    });

    it("never marks a line it did not create (a public-API copy at the base price)", async () => {
      fakeSaleor.beforeLinesAdd = (checkout) => {
        fakeSaleor.beforeLinesAdd = null;
        // A shopper races the app with checkoutLinesAdd + the same metadata. They
        // cannot know the app's fresh reference, and cannot set a custom price.
        const forged = incomingLineMetadata().filter((m) => m.key !== REF_KEY);

        checkout.lines.push(fakeSaleor.newLine(BASE, 1, 15, forged));
      };

      const res = await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });

      expect(res._status).toBe(200);
      const [forgedLine, appLine] = cableLines(checkoutId);

      expect(forgedLine.unitPrice).toBe(15);
      expect(forgedLine.privateMetadata).toStrictEqual([]);
      expect(appLine.unitPrice).toBe(30);
      expect(markerOf(appLine)).toBeDefined();
    });

    // P2-c: an app-priced cable line must never exist without its marker.
    it("fails closed (503) and deletes the line when the reference is ambiguous", async () => {
      fakeSaleor.beforeLinesAdd = (checkout) => {
        fakeSaleor.beforeLinesAdd = null;
        checkout.lines.push(fakeSaleor.newLine(BASE, 1, 15, [...incomingLineMetadata()]));
      };

      const res = await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });

      expect(res._status).toBe(503);
      expect(cableLines(checkoutId)).toHaveLength(0);
      expect(fakeSaleor.mutationNames()).toStrictEqual(["AddLinesToCheckout", "CheckoutLinesDelete"]);
      expect(console.error).toHaveBeenCalled();
    });

    it("fails closed (503) and deletes the line when the marker write fails", async () => {
      fakeSaleor.failingOperations.add("CableLineMarker");

      const res = await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });

      expect(res._status).toBe(503);
      expect(res._json).toMatchObject({ errorMessage: expect.stringMatching(/retry/i) });
      expect(cableLines(checkoutId)).toHaveLength(0);
      expect(fakeSaleor.mutationNames()).toStrictEqual([
        "AddLinesToCheckout",
        "CableLineMarker",
        "CableLineMarker",
        "CheckoutLinesDelete",
      ]);
    });

    it("also deletes the line of a newly created checkout when the marker write fails", async () => {
      fakeSaleor.failingOperations.add("CableLineMarker");

      const res = await callCable({ baseVariantId: BASE, configuration: validConfiguration() });

      expect(res._status).toBe(503);
      const created = Array.from(fakeSaleor.checkouts.values()).find((c) => c.id !== checkoutId);

      expect(created?.lines).toHaveLength(0);
    });

    it("still answers 503 and keeps the stable error log when the delete fails too", async () => {
      fakeSaleor.failingOperations.add("CableLineMarker");
      fakeSaleor.failingOperations.add("CheckoutLinesDelete");

      const res = await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });

      expect(res._status).toBe(503);
      expect(vi.mocked(console.error).mock.calls.map((c) => c[0])).toContain(MARKER_WRITE_FAILED_LOG);
    });

    // L1 (payments review): a transient failure must not leave a priced line unmarked.
    it("retries the marker write once, silently, when the first attempt fails", async () => {
      fakeSaleor.failingOperationsOnce.add("CableLineMarker");

      const res = await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });

      expect(res._status).toBe(200);
      const [line] = cableLines(checkoutId);

      expect(fakeSaleor.mutationNames()).toStrictEqual(["AddLinesToCheckout", "CableLineMarker", "CableLineMarker"]);
      expect(JSON.parse(markerOf(line) ?? "null")).toStrictEqual({ v: 1, metadata: recordOf(line.metadata) });
      expect(console.error).not.toHaveBeenCalled();
    });

    it("logs ONE stable error-level message for alerting when the retry fails too", async () => {
      fakeSaleor.failingOperations.add("CableLineMarker");

      const res = await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });

      expect(res._status).toBe(503);
      expect(fakeSaleor.mutationNames()).toStrictEqual([
        "AddLinesToCheckout",
        "CableLineMarker",
        "CableLineMarker",
        "CheckoutLinesDelete",
      ]);
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(vi.mocked(console.error).mock.calls[0][0]).toBe(MARKER_WRITE_FAILED_LOG);
    });

    it("logs its own stable message when the new line cannot be identified (no write, no retry)", async () => {
      fakeSaleor.beforeLinesAdd = (checkout) => {
        fakeSaleor.beforeLinesAdd = null;
        checkout.lines.push(fakeSaleor.newLine(BASE, 1, 15, [...incomingLineMetadata()]));
      };
      const res = await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });

      expect(res._status).toBe(503);
      // ambiguous reference: never guessed, so no write and no retry — but the alert fires
      expect(fakeSaleor.mutationNames()).toStrictEqual(["AddLinesToCheckout", "CheckoutLinesDelete"]);
      expect(vi.mocked(console.error).mock.calls[0][0]).toBe(MARKER_LINE_NOT_FOUND_LOG);
    });
  });

  describe("component names (P1-a: Saleor's names, never the caller's)", () => {
    const FORGED = "FORGED 50 m cable";
    const forgedNames = {
      variantName: FORGED,
      connecteur1Name: FORGED,
      connecteur2Name: FORGED,
      connecteur3Name: FORGED,
      typeCableName: FORGED,
      referenceGaineName: FORGED,
      longueurCableName: FORGED,
    };

    it("ignores every caller-typed name, in the public metadata and in the marker", async () => {
      const res = await callCable({
        checkoutId,
        baseVariantId: BASE,
        configuration: validConfiguration(forgedNames),
      });

      expect(res._status).toBe(200);
      const [line] = cableLines(checkoutId);

      for (const target of [recordOf(line.metadata), recordedConfiguration(line)]) {
        expect(target["variant_name"]).toBe(SALEOR_NAMES.variantName);
        expect(target["connecteur_1_name"]).toBe(SALEOR_NAMES.connecteur1Name);
        expect(target["connecteur_2_name"]).toBe(SALEOR_NAMES.connecteur2Name);
        expect(target["type_cable_name"]).toBe(SALEOR_NAMES.typeCableName);
        expect(target["reference_gaine_name"]).toBe(SALEOR_NAMES.referenceGaineName);
        expect(target["longueur_cable_name"]).toBe("100cm");
        expect(Object.values(target)).not.toContain(FORGED);
      }
    });

    it("ignores the caller's connector 3 name too", async () => {
      await callCable({
        checkoutId,
        baseVariantId: BASE_Y,
        configuration: validConfiguration({ ...forgedNames, referenceGaineId: null, connecteur3Id: CONNECTOR_C }),
      });
      const [line] = cableLines(checkoutId);

      expect(recordOf(line.metadata)["connecteur_3_name"]).toBe(SALEOR_NAMES.connecteur3Name);
    });

    it("never writes a PUBLIC metadata key containing a dot", async () => {
      await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });
      await callCable({ baseVariantId: BASE_Y, configuration: validConfiguration({ connecteur3Id: CONNECTOR_C, referenceGaineId: null }) });

      const lines = Array.from(fakeSaleor.checkouts.values()).flatMap((c) => c.lines);

      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) {
        expect(line.metadata.filter((m) => m.key.includes("."))).toStrictEqual([]);
      }
      for (const call of fakeSaleor.calls.filter((c) => c.name === "CableLineMarker")) {
        // only the PRIVATE marker key carries a dot
        expect((call.variables.input as Array<{ key: string }>).map((m) => m.key)).toStrictEqual([MARKER_KEY]);
      }
    });

    it("uses the checkout's language: translation first, base name as fallback", async () => {
      fakeSaleor.variants.get(CONNECTOR_A)!.productTranslations = { EN: "Jack A (EN)" };
      fakeSaleor.variants.get(GAINE)!.translations = { EN: "Sleeve (EN)" };
      const en = fakeSaleor.addCheckout({ languageCode: "EN" }).id;

      const res = await callCable({ checkoutId: en, baseVariantId: BASE, configuration: validConfiguration(forgedNames) });

      expect(res._status).toBe(200);
      const [line] = cableLines(en);
      const names = recordOf(line.metadata);

      expect(names["connecteur_1_name"]).toBe("Jack A (EN)");
      expect(names["reference_gaine_name"]).toBe("Sleeve (EN)");
      // no EN translation -> the base name
      expect(names["connecteur_2_name"]).toBe(SALEOR_NAMES.connecteur2Name);
      expect(recordedConfiguration(line)["connecteur_1_name"]).toBe("Jack A (EN)");
      const lookup = fakeSaleor.calls.find((c) => c.name === "CableNames");

      expect(lookup?.variables).toMatchObject({ lang: "EN", tr: true, channel: "default-channel" });
    });

    it("keeps the base names for a checkout in a language without translations", async () => {
      fakeSaleor.variants.get(CONNECTOR_A)!.productTranslations = { EN: "Jack A (EN)" };
      const fr = fakeSaleor.addCheckout({ languageCode: "FR" }).id;

      await callCable({ checkoutId: fr, baseVariantId: BASE, configuration: validConfiguration() });

      expect(recordOf(cableLines(fr)[0].metadata)["connecteur_1_name"]).toBe(SALEOR_NAMES.connecteur1Name);
    });

    it("fails closed when the names cannot be loaded", async () => {
      fakeSaleor.failingOperations.add("CableNames");

      const res = await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });

    it("fails closed when a selected component's name is not returned", async () => {
      fakeSaleor.hiddenFromNames.add(CABLE);

      const res = await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });
  });

  describe("direction (NR-35: no caller-supplied name is trusted)", () => {
    it("refuses a value of another attribute even when that attribute exists in Saleor", async () => {
      const res = await callCable({
        checkoutId,
        baseVariantId: BASE,
        configuration: validConfiguration({ directionCableId: DIRECTION_OTHER }),
      });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });

    it("uses the direction attribute assigned to the base variant (slug 'direction' here)", async () => {
      const base = fakeSaleor.variants.get(BASE)!;

      base.attributes = base.attributes.map((a) => (a.slug === "direction-cable" ? { ...a, slug: "direction" } : a));

      const ok = await callCable({
        checkoutId,
        baseVariantId: BASE,
        configuration: validConfiguration({ directionCableId: DIRECTION_OTHER }),
      });
      const notOffered = await callCable({
        checkoutId,
        baseVariantId: BASE,
        configuration: validConfiguration({ directionCableId: DIRECTION_DROIT }),
      });

      expect(ok._status).toBe(200);
      expect(notOffered._status).toBe(400);
      expect(metaValue(cableLines(checkoutId)[0].metadata, "direction_cable_name")).toBe("Autre");
    });

    it("refuses a base variant that has no direction attribute", async () => {
      const base = fakeSaleor.variants.get(BASE)!;

      base.attributes = base.attributes.filter((a) => a.slug !== "direction-cable");

      const res = await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });


    it("writes the direction NAME Saleor holds for the id, not the caller's label", async () => {
      const res = await callCable({
        checkoutId,
        baseVariantId: BASE,
        configuration: validConfiguration({ directionCableId: DIRECTION_COUDE, directionCableName: "Droit" }),
      });

      expect(res._status).toBe(200);
      const [line] = cableLines(checkoutId);

      expect(metaValue(line.metadata, "direction_cable_id")).toBe(DIRECTION_COUDE);
      expect(metaValue(line.metadata, "direction_cable_name")).toBe("Coudé");
      expect(recordedConfiguration(line)["direction_cable_name"]).toBe("Coudé");
    });

    it.each([
      ["a made-up value id", toGlobalId("AttributeValue", 999)],
      ["free text", "droit"],
      ["a variant id", SCREW],
    ])("refuses %s as the direction without touching the checkout", async (_label, directionCableId) => {
      const res = await callCable({
        checkoutId,
        baseVariantId: BASE,
        configuration: validConfiguration({ directionCableId }),
      });

      expect(res._status).toBe(400);
      expect(fakeSaleor.mutationNames()).toStrictEqual([]);
    });

    it("fails closed when the direction options cannot be loaded", async () => {
      fakeSaleor.failingOperations.add("CableDirectionChoices");

      const res = await callCable({ checkoutId, baseVariantId: BASE, configuration: validConfiguration() });

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
