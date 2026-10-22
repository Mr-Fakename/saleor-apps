import { describe, expect, it } from "vitest";

import {
  buildCableConfigMarker,
  CABLE_CONFIG_MARKER_KEY,
  CABLE_LINE_REF_KEY,
  findLineByRef,
} from "../modules/cable/cable-line-marker";

/**
 * NR-33: the private marker is a cross-repo contract. saleor-dashboard
 * (src/orders/components/OrderCableConfigurationDialog/cableConfiguration.ts)
 * parses it and compares it with the order line's PUBLIC metadata, so the
 * format pinned here must not change without a version bump on both sides.
 */

const SAMPLE = [
  { key: "configurator_type", value: "cable" },
  { key: "longueur_cable_cm", value: "100" },
  { key: "total_price", value: "30.00" },
  { key: "connecteur_1_id", value: "UHJvZHVjdFZhcmlhbnQ6MTAx" },
  { key: "component_gaine_price", value: "1.00" },
  { key: "cable_line_ref", value: "3f1c2b8e-0000-4000-8000-000000000001" },
];

describe("cable line marker (NR-33)", () => {
  it("uses the agreed metadata keys", () => {
    expect(CABLE_CONFIG_MARKER_KEY).toBe("checkout_prices.cable_config");
    expect(CABLE_LINE_REF_KEY).toBe("cable_line_ref");
  });

  it("is the canonical JSON {v:1, metadata} with keys in sorted order (golden value)", () => {
    expect(buildCableConfigMarker(SAMPLE)).toBe(
      '{"v":1,"metadata":{' +
        '"cable_line_ref":"3f1c2b8e-0000-4000-8000-000000000001",' +
        '"component_gaine_price":"1.00",' +
        '"configurator_type":"cable",' +
        '"connecteur_1_id":"UHJvZHVjdFZhcmlhbnQ6MTAx",' +
        '"longueur_cable_cm":"100",' +
        '"total_price":"30.00"}}',
    );
  });

  it("does not depend on the order the entries were written in", () => {
    expect(buildCableConfigMarker([...SAMPLE].reverse())).toBe(buildCableConfigMarker(SAMPLE));
  });

  it.each(SAMPLE.map((entry) => entry.key))("changes when the value of %s changes", (key) => {
    const changed = SAMPLE.map((entry) => (entry.key === key ? { key, value: `${entry.value}9` } : entry));

    expect(buildCableConfigMarker(changed)).not.toBe(buildCableConfigMarker(SAMPLE));
  });

  it("changes when an entry is added or removed", () => {
    expect(buildCableConfigMarker([...SAMPLE, { key: "connecteur_3_name", value: "XLR" }])).not.toBe(
      buildCableConfigMarker(SAMPLE),
    );
    expect(buildCableConfigMarker(SAMPLE.slice(1))).not.toBe(buildCableConfigMarker(SAMPLE));
  });

  it("keeps the LAST value of a repeated key, like Saleor's metadata dict", () => {
    const marker = buildCableConfigMarker([
      { key: "total_price", value: "1.00" },
      { key: "total_price", value: "30.00" },
    ]);

    expect(JSON.parse(marker)).toStrictEqual({ v: 1, metadata: { total_price: "30.00" } });
  });

  describe("findLineByRef", () => {
    const line = (id: string, ref?: string) => ({
      id,
      metadata: ref === undefined ? [] : [{ key: CABLE_LINE_REF_KEY, value: ref }],
    });

    it("returns the one line carrying the reference", () => {
      expect(findLineByRef([line("a"), line("b", "ref-1"), line("c", "ref-2")], "ref-1")?.id).toBe("b");
    });

    it("returns null when no line carries it", () => {
      expect(findLineByRef([line("a"), line("b", "ref-2")], "ref-1")).toBeNull();
    });

    it("returns null when several lines carry it (a copied reference — fail safe)", () => {
      expect(findLineByRef([line("a", "ref-1"), line("b", "ref-1")], "ref-1")).toBeNull();
    });
  });
});
