import { describe, it, expect } from "vitest";
import {
  vatPatterns,
  validateVatFormat,
  isEuCountry,
  EU_COUNTRY_CODES,
} from "../vat-patterns";

describe("vatPatterns", () => {
  it("has patterns for all 27 EU member states", () => {
    expect(EU_COUNTRY_CODES).toHaveLength(27);
  });

  const validCases: [string, string][] = [
    ["AT", "ATU12345678"],
    ["BE", "BE0123456789"],
    ["BG", "BG123456789"],
    ["HR", "HR12345678901"],
    ["CY", "CY12345678A"],
    ["CZ", "CZ12345678"],
    ["DK", "DK12345678"],
    ["EE", "EE123456789"],
    ["FI", "FI12345678"],
    ["FR", "FR12345678901"],
    ["FR", "FRXX345678901"],
    ["DE", "DE123456789"],
    ["GR", "EL123456789"],
    ["HU", "HU12345678"],
    ["IE", "IE1234567A"],
    ["IE", "IE1234567AB"],
    ["IT", "IT12345678901"],
    ["LV", "LV12345678901"],
    ["LT", "LT123456789"],
    ["LT", "LT123456789012"],
    ["LU", "LU12345678"],
    ["MT", "MT12345678"],
    ["NL", "NL123456789B01"],
    ["PL", "PL1234567890"],
    ["PT", "PT123456789"],
    ["RO", "RO12"],
    ["RO", "RO1234567890"],
    ["SK", "SK1234567890"],
    ["SI", "SI12345678"],
    ["ES", "ESA1234567B"],
    ["ES", "ES12345678A"],
    ["SE", "SE123456789012"],
  ];

  it.each(validCases)("accepts valid %s VAT: %s", (country, vat) => {
    expect(vatPatterns[country].test(vat)).toBe(true);
  });

  const invalidCases: [string, string][] = [
    ["AT", "ATU1234567"], // Too short
    ["BE", "BE234567890"], // Doesn't start with 0 or 1
    ["BG", "BG12345678"], // Too short
    ["HR", "HR1234567890"], // Too short
    ["CY", "CY123456789"], // Missing letter
    ["CZ", "CZ1234567"], // Too short
    ["DK", "DK1234567"], // Too short
    ["EE", "EE12345678"], // Too short
    ["FI", "FI1234567"], // Too short
    ["FR", "FRI2345678901"], // I is excluded
    ["DE", "DE12345678"], // Too short
    ["GR", "GR123456789"], // Should use EL prefix
    ["HU", "HU1234567"], // Too short
    ["IE", "IE1234567"], // Missing letter
    ["IT", "IT1234567890"], // Too short
    ["LV", "LV1234567890"], // Too short
    ["LT", "LT12345678"], // Too short
    ["LU", "LU1234567"], // Too short
    ["MT", "MT1234567"], // Too short
    ["NL", "NL123456789012"], // Wrong format (missing B)
    ["PL", "PL123456789"], // Too short
    ["PT", "PT12345678"], // Too short
    ["RO", "RO1"], // Too short
    ["SK", "SK123456789"], // Too short
    ["SI", "SI1234567"], // Too short
    ["ES", "ES1234567"], // Too short
    ["SE", "SE12345678901"], // Too short
  ];

  it.each(invalidCases)("rejects invalid %s VAT: %s", (country, vat) => {
    expect(vatPatterns[country].test(vat)).toBe(false);
  });
});

describe("validateVatFormat", () => {
  it("validates and returns country code for valid VAT", () => {
    const result = validateVatFormat("DE123456789");
    expect(result.valid).toBe(true);
    expect(result.countryCode).toBe("DE");
  });

  it("handles whitespace and lowercase", () => {
    const result = validateVatFormat("de 123 456 789");
    expect(result.valid).toBe(true);
    expect(result.countryCode).toBe("DE");
  });

  it("returns invalid for unknown format", () => {
    const result = validateVatFormat("XX123456789");
    expect(result.valid).toBe(false);
    expect(result.countryCode).toBeNull();
  });

  it("handles Greece EL prefix correctly", () => {
    const result = validateVatFormat("EL123456789");
    expect(result.valid).toBe(true);
    expect(result.countryCode).toBe("GR");
  });
});

describe("isEuCountry", () => {
  it("returns true for EU countries", () => {
    expect(isEuCountry("DE")).toBe(true);
    expect(isEuCountry("FR")).toBe(true);
    expect(isEuCountry("IT")).toBe(true);
  });

  it("returns false for non-EU countries", () => {
    expect(isEuCountry("US")).toBe(false);
    expect(isEuCountry("CH")).toBe(false);
    expect(isEuCountry("GB")).toBe(false);
    expect(isEuCountry("JP")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isEuCountry("de")).toBe(true);
  });
});
