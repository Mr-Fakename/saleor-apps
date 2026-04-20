import { describe, it, expect } from "vitest";
import {
  userB2bMetadataSchema,
  checkoutB2bMetadataSchema,
  orderB2bMetadataSchema,
  extractB2bMetadata,
} from "../b2b-metadata-schema";

describe("userB2bMetadataSchema", () => {
  it("validates correct metadata", () => {
    const result = userB2bMetadataSchema.safeParse({
      b2b_is_business: "true",
      b2b_vat_number: "DE123456789",
      b2b_vat_validated: "true",
      b2b_vat_validated_at: "2026-03-17T10:00:00.000Z",
      b2b_vat_country: "DE",
      b2b_company_legal_name: "Test GmbH",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid VAT format", () => {
    const result = userB2bMetadataSchema.safeParse({
      b2b_is_business: "true",
      b2b_vat_number: "invalid",
      b2b_vat_validated: "true",
      b2b_vat_validated_at: "2026-03-17T10:00:00.000Z",
      b2b_vat_country: "DE",
      b2b_company_legal_name: "Test GmbH",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid boolean strings", () => {
    const result = userB2bMetadataSchema.safeParse({
      b2b_is_business: "yes",
      b2b_vat_number: "DE123456789",
      b2b_vat_validated: "true",
      b2b_vat_validated_at: "2026-03-17T10:00:00.000Z",
      b2b_vat_country: "DE",
      b2b_company_legal_name: "Test GmbH",
    });
    expect(result.success).toBe(false);
  });
});

describe("checkoutB2bMetadataSchema", () => {
  it("validates correct checkout metadata", () => {
    const result = checkoutB2bMetadataSchema.safeParse({
      b2b_vat_number: "FR12345678901",
      b2b_vat_validated: "true",
      b2b_reverse_charge: "true",
      b2b_tax_exempt_reason: "INTRA_EU_REVERSE_CHARGE",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid tax exempt reason", () => {
    const result = checkoutB2bMetadataSchema.safeParse({
      b2b_vat_number: "FR12345678901",
      b2b_vat_validated: "true",
      b2b_reverse_charge: "true",
      b2b_tax_exempt_reason: "INVALID_REASON",
    });
    expect(result.success).toBe(false);
  });
});

describe("orderB2bMetadataSchema", () => {
  it("validates correct order metadata", () => {
    const result = orderB2bMetadataSchema.safeParse({
      b2b_reverse_charge: "true",
      b2b_buyer_vat_number: "DE123456789",
      b2b_seller_vat_number: "FR12345678901",
      b2b_tax_exempt_reason: "INTRA_EU_REVERSE_CHARGE",
    });
    expect(result.success).toBe(true);
  });
});

describe("extractB2bMetadata", () => {
  it("extracts only B2B keys from metadata array", () => {
    const metadata = [
      { key: "b2b_vat_number", value: "DE123456789" },
      { key: "b2b_reverse_charge", value: "true" },
      { key: "other_key", value: "other_value" },
      { key: "b2b_tax_exempt_reason", value: "INTRA_EU_REVERSE_CHARGE" },
    ];

    const result = extractB2bMetadata(metadata);

    expect(result).toEqual({
      b2b_vat_number: "DE123456789",
      b2b_reverse_charge: "true",
      b2b_tax_exempt_reason: "INTRA_EU_REVERSE_CHARGE",
    });
    expect(result).not.toHaveProperty("other_key");
  });

  it("returns empty object for no B2B metadata", () => {
    const metadata = [
      { key: "other_key", value: "other_value" },
    ];

    expect(extractB2bMetadata(metadata)).toEqual({});
  });

  it("handles empty metadata array", () => {
    expect(extractB2bMetadata([])).toEqual({});
  });
});
