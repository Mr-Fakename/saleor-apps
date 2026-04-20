import { describe, it, expect } from "vitest";
import { evaluateTaxExemption } from "../eu-country-rules";

describe("evaluateTaxExemption", () => {
  describe("domestic (FR)", () => {
    it("FR + valid VAT = DOMESTIC_B2B, not exempt", () => {
      const result = evaluateTaxExemption("FR", true, "FR", "FR");
      expect(result.exempt).toBe(false);
      expect(result.reason).toBe("DOMESTIC_B2B");
    });

    it("FR + no VAT = DOMESTIC_B2C, not exempt", () => {
      const result = evaluateTaxExemption("FR", false, "FR", "FR");
      expect(result.exempt).toBe(false);
      expect(result.reason).toBe("DOMESTIC_B2C");
    });
  });

  describe("intra-EU with valid VAT + matching billing", () => {
    const euCountries = ["DE", "IT", "ES", "NL", "BE", "AT", "PL", "SE"];

    it.each(euCountries)("%s + valid VAT + matching billing + foreign shipping = EXEMPT", (country) => {
      const result = evaluateTaxExemption(country, true, country, country);
      expect(result.exempt).toBe(true);
      expect(result.reason).toBe("INTRA_EU_REVERSE_CHARGE");
      expect(result.denied).toBeUndefined();
    });
  });

  describe("anti-fraud: billing country mismatch", () => {
    it("DE VAT + FR billing = DENIED (BILLING_COUNTRY_MISMATCH)", () => {
      const result = evaluateTaxExemption("DE", true, "FR", "DE");
      expect(result.exempt).toBe(false);
      expect(result.denied).toBe("BILLING_COUNTRY_MISMATCH");
    });

    it("IT VAT + ES billing = DENIED", () => {
      const result = evaluateTaxExemption("IT", true, "ES", "IT");
      expect(result.exempt).toBe(false);
      expect(result.denied).toBe("BILLING_COUNTRY_MISMATCH");
    });
  });

  describe("anti-fraud: domestic delivery", () => {
    it("DE VAT + DE billing + FR shipping = DENIED (DOMESTIC_DELIVERY)", () => {
      const result = evaluateTaxExemption("DE", true, "DE", "FR");
      expect(result.exempt).toBe(false);
      expect(result.denied).toBe("DOMESTIC_DELIVERY");
    });

    it("ES VAT + ES billing + FR shipping = DENIED", () => {
      const result = evaluateTaxExemption("ES", true, "ES", "FR");
      expect(result.exempt).toBe(false);
      expect(result.denied).toBe("DOMESTIC_DELIVERY");
    });

    it("DE VAT + DE billing + DE shipping = EXEMPT (genuine cross-border)", () => {
      const result = evaluateTaxExemption("DE", true, "DE", "DE");
      expect(result.exempt).toBe(true);
      expect(result.reason).toBe("INTRA_EU_REVERSE_CHARGE");
    });
  });

  describe("the exact fraud scenario: FR personal address + DE VAT", () => {
    it("DE VAT + FR billing + FR shipping = DENIED", () => {
      const result = evaluateTaxExemption("DE", true, "FR", "FR");
      expect(result.exempt).toBe(false);
      expect(result.denied).toBe("BILLING_COUNTRY_MISMATCH");
    });
  });

  describe("non-EU countries", () => {
    const nonEuCountries = ["US", "GB", "CH", "JP", "AU"];

    it.each(nonEuCountries)("%s = NON_EU_EXPORT, exempt", (country) => {
      const result = evaluateTaxExemption(country, false);
      expect(result.exempt).toBe(true);
      expect(result.reason).toBe("NON_EU_EXPORT");
    });
  });

  describe("backward compatibility (no billing/shipping args)", () => {
    it("DE + valid VAT = exempt (billing defaults to VAT country)", () => {
      const result = evaluateTaxExemption("DE", true);
      expect(result.exempt).toBe(true);
      expect(result.reason).toBe("INTRA_EU_REVERSE_CHARGE");
    });

    it("DE + invalid VAT = not exempt", () => {
      const result = evaluateTaxExemption("DE", false);
      expect(result.exempt).toBe(false);
      expect(result.reason).toBe("INTRA_EU_NO_VALID_VAT");
    });
  });
});
