import { describe, expect, it } from "vitest";

import { addCableVerificationColumn, parseCableVerificationCutoff, verifyCableLine } from "./verify-cable-line";

/**
 * NR-33 / NR-36. The rule "is this order line's PUBLIC cable metadata exactly
 * what checkout-prices recorded privately?" exists once per repo (the repos
 * cannot share code): here, and in saleor-dashboard
 * src/orders/components/OrderCableConfigurationDialog/cableConfiguration.ts.
 * GOLDEN_VECTORS below is IDENTICAL in
 * saleor-dashboard/.../cableConfiguration.test.ts — change both or neither.
 */

type Entry = { key: string; value: string };
type Expected = { result: "verified" | "missing-marker" | "invalid-marker" | "modified"; changedKeys: string[] };

const MARKER_KEY = "checkout_prices.cable_config";
const base: Entry[] = [
  { key: "configurator_type", value: "cable" },
  { key: "cable_line_ref", value: "3f1c2b8e-0000-4000-8000-000000000001" },
  { key: "connecteur_1_id", value: "UHJvZHVjdFZhcmlhbnQ6MTAx" },
  { key: "connecteur_1_name", value: "Jack A" },
  { key: "longueur_cable_cm", value: "100" },
  { key: "total_price", value: "30.00" },
];
const marker = (entries: Entry[]): Entry => ({
  key: MARKER_KEY,
  value: JSON.stringify({ v: 1, metadata: Object.fromEntries(entries.map((e) => [e.key, e.value])) }),
});
const withValue = (entries: Entry[], key: string, value: string): Entry[] => [
  ...entries.filter((e) => e.key !== key),
  { key, value },
];

// ---- GOLDEN VECTORS (keep identical to the dashboard's cableConfiguration.test.ts) ----
const GOLDEN_VECTORS: Array<{ name: string; metadata: Entry[]; privateMetadata: Entry[]; expected: Expected }> = [
  {
    name: "verified: public metadata equals the marker",
    metadata: base,
    privateMetadata: [marker(base)],
    expected: { result: "verified", changedKeys: [] },
  },
  {
    name: "verified: another app's namespaced key (contains a dot) is ignored",
    metadata: [...base, { key: "some_other_app.note", value: "gift wrap" }],
    privateMetadata: [marker(base)],
    expected: { result: "verified", changedKeys: [] },
  },
  {
    name: "NR-36 modified: an extra cable key the app never wrote (couleur_cable_name)",
    metadata: [...base, { key: "couleur_cable_name", value: "Rouge" }],
    privateMetadata: [marker(base)],
    expected: { result: "modified", changedKeys: ["couleur_cable_name"] },
  },
  {
    name: "NR-36 modified: an extra key with an empty value",
    metadata: [...base, { key: "note", value: "" }],
    privateMetadata: [marker(base)],
    expected: { result: "modified", changedKeys: ["note"] },
  },
  {
    name: "modified: a recorded key was deleted",
    metadata: base.filter((e) => e.key !== "total_price"),
    privateMetadata: [marker(base)],
    expected: { result: "modified", changedKeys: ["total_price"] },
  },
  {
    name: "modified: values changed",
    metadata: withValue(withValue(base, "longueur_cable_cm", "5000"), "total_price", "3000.00"),
    privateMetadata: [marker(base)],
    expected: { result: "modified", changedKeys: ["longueur_cable_cm", "total_price"] },
  },
  {
    name: "modified: the marker belongs to another (cheaper) line",
    metadata: withValue(base, "longueur_cable_cm", "2000"),
    privateMetadata: [marker(base)],
    expected: { result: "modified", changedKeys: ["longueur_cable_cm"] },
  },
  {
    name: "missing-marker: no private metadata",
    metadata: base,
    privateMetadata: [],
    expected: { result: "missing-marker", changedKeys: [] },
  },
  {
    name: "missing-marker: only unrelated private keys",
    metadata: base,
    privateMetadata: [{ key: "unrelated", value: "x" }],
    expected: { result: "missing-marker", changedKeys: [] },
  },
  {
    name: "invalid-marker: not JSON",
    metadata: base,
    privateMetadata: [{ key: MARKER_KEY, value: "not json" }],
    expected: { result: "invalid-marker", changedKeys: [] },
  },
  {
    name: "invalid-marker: another version",
    metadata: base,
    privateMetadata: [{ key: MARKER_KEY, value: '{"v":2,"metadata":{"configurator_type":"cable"}}' }],
    expected: { result: "invalid-marker", changedKeys: [] },
  },
  {
    name: "invalid-marker: non-string values",
    metadata: base,
    privateMetadata: [{ key: MARKER_KEY, value: '{"v":1,"metadata":{"total_price":30}}' }],
    expected: { result: "invalid-marker", changedKeys: [] },
  },
  {
    name: "invalid-marker: a JSON array",
    metadata: base,
    privateMetadata: [{ key: MARKER_KEY, value: '[{"v":1}]' }],
    expected: { result: "invalid-marker", changedKeys: [] },
  },
];
// ---- END GOLDEN VECTORS ----

const toRecord = (entries: Entry[]) => Object.fromEntries(entries.map((e) => [e.key, e.value]));

describe("verifyCableLine (golden vectors shared with the dashboard)", () => {
  it.each(GOLDEN_VECTORS)("$name", ({ metadata, privateMetadata, expected }) => {
    // Act — Postgres hands the export jsonb objects, not arrays
    const verification = verifyCableLine(toRecord(metadata), toRecord(privateMetadata));

    // Assert
    expect(verification).toStrictEqual(expected);
  });
});

describe("addCableVerificationColumn", () => {
  const cableRow = (metadata: Entry[], privateMetadata: Entry[]) => ({
    "Cable personnalise": "Oui",
    __is_cable_product: true,
    __metadata: toRecord(metadata),
    __private_metadata: toRecord(privateMetadata),
  });

  it("adds 'Câble vérifié' after 'Cable personnalise' and drops the raw metadata columns", () => {
    // Arrange
    const fields = ["Article", "Cable personnalise", "Cable - Type", "__metadata", "__private_metadata"];

    // Act
    const result = addCableVerificationColumn(
      [...fields, "__is_cable_product", "__created_at"],
      [],
    );

    // Assert
    expect(result.fields).toStrictEqual(["Article", "Cable personnalise", "Câble vérifié", "Cable - Type"]);
  });

  it("prints oui / non / modifié for a cable line and nothing for other lines", () => {
    // Arrange
    const rows = [
      cableRow(base, [marker(base)]),
      cableRow(base, []),
      cableRow([...base, { key: "couleur_cable_name", value: "Rouge" }], [marker(base)]),
      { "Cable personnalise": "", __is_cable_product: false, __metadata: {}, __private_metadata: {} },
    ];

    // Act
    const result = addCableVerificationColumn(["Cable personnalise", "__metadata", "__private_metadata"], rows);

    // Assert
    expect(result.rows.map((row) => row["Câble vérifié"])).toStrictEqual(["oui", "non", "modifié", ""]);
    expect(result.rows[0]).not.toHaveProperty("__metadata");
    expect(result.rows[0]).not.toHaveProperty("__private_metadata");
  });

  it("still reports a line whose public configurator_type was deleted, when the marker exists", () => {
    // Arrange — a shopper stripped the public sentinel key from a genuine line
    const stripped = base.filter((e) => e.key !== "configurator_type");
    const row = { "Cable personnalise": "", __metadata: toRecord(stripped), __private_metadata: toRecord([marker(base)]) };

    // Act
    const result = addCableVerificationColumn(["Cable personnalise", "__metadata", "__private_metadata"], [row]);

    // Assert
    expect(result.rows[0]["Câble vérifié"]).toBe("modifié");
  });

  it("treats null metadata (a NULL column) as empty: not a cable line, empty cell", () => {
    // Arrange
    const row = { "Cable personnalise": "Oui", __is_cable_product: false, __metadata: null, __private_metadata: null };

    // Act
    const result = addCableVerificationColumn(["Cable personnalise", "__metadata", "__private_metadata"], [row]);

    // Assert
    expect(result.rows[0]["Câble vérifié"]).toBe("");
  });
});

describe("addCableVerificationColumn: what counts as a cable line (P2-d)", () => {
  const run = (row: Record<string, unknown>, options?: { cutoff?: Date | null }) =>
    addCableVerificationColumn(["Cable personnalise", "__metadata", "__private_metadata"], [row], options).rows[0][
      "Câble vérifié"
    ];

  it("a line of the cable product with no marker is a cable line: 'non'", () => {
    // Arrange — public metadata wiped by the shopper, no marker either
    const row = { __is_cable_product: true, __metadata: {}, __private_metadata: {} };

    // Act + Assert
    expect(run(row)).toBe("non");
  });

  it("a line of ANOTHER product claiming configurator_type=cable is not a cable line", () => {
    // Arrange
    const row = { __is_cable_product: false, __metadata: toRecord(base), __private_metadata: {} };

    // Act + Assert
    expect(run(row)).toBe("");
  });

  it("a marker makes it a cable line whatever the product", () => {
    // Arrange
    const row = { __is_cable_product: false, __metadata: toRecord(base), __private_metadata: toRecord([marker(base)]) };

    // Act + Assert
    expect(run(row)).toBe("oui");
  });
});

describe("addCableVerificationColumn: orders created before CABLE_VERIFICATION_CUTOFF (P2-d)", () => {
  const cutoff = new Date("2026-10-23T00:00:00Z");
  const run = (createdAt: string, privateMetadata: Entry[], options?: { cutoff?: Date | null }) =>
    addCableVerificationColumn(
      ["Cable personnalise", "__metadata", "__private_metadata", "__created_at"],
      [
        {
          __is_cable_product: true,
          __created_at: new Date(createdAt),
          __metadata: toRecord(base),
          __private_metadata: toRecord(privateMetadata),
        },
      ],
      options,
    ).rows[0]["Câble vérifié"];

  it("an unmarked line from before the cutoff is 'non (avant vérification)'", () => {
    expect(run("2026-10-01T10:00:00Z", [], { cutoff })).toBe("non (avant vérification)");
  });

  it("an unmarked line from after the cutoff is a plain 'non'", () => {
    expect(run("2026-10-24T10:00:00Z", [], { cutoff })).toBe("non");
  });

  it("without a cutoff every unmarked line is a plain 'non'", () => {
    expect(run("2026-10-01T10:00:00Z", [])).toBe("non");
    expect(run("2026-10-01T10:00:00Z", [], { cutoff: null })).toBe("non");
  });

  it("the cutoff never softens a line whose marker disagrees", () => {
    const other = withValue(base, "total_price", "1.00");

    expect(run("2026-10-01T10:00:00Z", [marker(other)], { cutoff })).toBe("modifié");
    expect(run("2026-10-01T10:00:00Z", [marker(base)], { cutoff })).toBe("oui");
  });
});

describe("parseCableVerificationCutoff", () => {
  it.each([
    ["2026-10-23T00:00:00Z", "2026-10-23T00:00:00.000Z"],
    [" 2026-10-23 ", "2026-10-23T00:00:00.000Z"],
  ])("reads %s", (raw, iso) => {
    expect(parseCableVerificationCutoff(raw)?.toISOString()).toBe(iso);
  });

  it.each([[undefined], [""], ["  "], ["not a date"]])("treats %s as no cutoff", (raw) => {
    expect(parseCableVerificationCutoff(raw)).toBeNull();
  });
});
