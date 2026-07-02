import { describe, expect, it } from "vitest";
import { getVariantPrice } from "./get-variant-price";

describe("getVariantPrice", () => {
  // The reported double-discount bug: with no quantity-tier pricing the function
  // must return undefined so the caller omits the line `price` override and lets
  // Saleor apply the catalog promotion exactly once.
  it("returns undefined when there is no quantity-tier pricing", () => {
    expect(getVariantPrice(1, null, 747.15)).toBeUndefined();
    expect(getVariantPrice(1, undefined, 747.15)).toBeUndefined();
    expect(getVariantPrice(1, "", 879)).toBeUndefined();
  });

  it("returns undefined for invalid quantity-pricing JSON", () => {
    expect(getVariantPrice(5, "not json", 879)).toBeUndefined();
  });

  it("falls back to the UNDISCOUNTED price below the lowest threshold", () => {
    // 879 is the undiscounted base; a tier starts at 10. Below it, no tier value
    // applies, so the undiscounted base is used (promotion then applied once).
    expect(getVariantPrice(1, JSON.stringify({ "10": "5", "20": "4" }), 879)).toBe(879);
  });

  it("applies the matching tier price at/above a threshold", () => {
    const tiers = JSON.stringify({ "10": "5", "20": "4" });
    expect(getVariantPrice(10, tiers, 879)).toBe(5);
    expect(getVariantPrice(15, tiers, 879)).toBe(5);
    expect(getVariantPrice(20, tiers, 879)).toBe(4);
    expect(getVariantPrice(100, tiers, 879)).toBe(4);
  });
});
