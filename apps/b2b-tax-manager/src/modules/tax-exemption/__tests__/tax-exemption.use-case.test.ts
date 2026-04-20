import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeTaxExemption, TaxExemptionInput } from "../tax-exemption.use-case";
import { SaleorGraphqlClient } from "../../saleor-client/saleor-graphql-client";

describe("executeTaxExemption", () => {
  let mockClient: SaleorGraphqlClient;

  beforeEach(() => {
    mockClient = {
      setTaxExemption: vi.fn().mockResolvedValue(undefined),
      updateCheckoutMetadata: vi.fn().mockResolvedValue(undefined),
      updateOrderMetadata: vi.fn().mockResolvedValue(undefined),
      updateUserPrivateMetadata: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("exempts intra-EU B2B with valid VAT", async () => {
    const input: TaxExemptionInput = {
      checkoutId: "checkout-1",
      billingCountryCode: "DE",
      vatNumber: "DE123456789",
      vatValidated: true,
    };

    const result = await executeTaxExemption(input, mockClient);

    expect(result.exempt).toBe(true);
    expect(result.reason).toBe("INTRA_EU_REVERSE_CHARGE");
    expect(result.metadataUpdated).toBe(true);
    expect(mockClient.setTaxExemption).toHaveBeenCalledWith("checkout-1", true);
    expect(mockClient.updateCheckoutMetadata).toHaveBeenCalledWith("checkout-1", expect.arrayContaining([
      { key: "b2b_reverse_charge", value: "true" },
      { key: "b2b_vat_number", value: "DE123456789" },
      { key: "b2b_vat_validated", value: "true" },
    ]));
  });

  it("does NOT exempt domestic FR B2B", async () => {
    const input: TaxExemptionInput = {
      checkoutId: "checkout-2",
      billingCountryCode: "FR",
      vatNumber: "FR12345678901",
      vatValidated: true,
    };

    const result = await executeTaxExemption(input, mockClient);

    expect(result.exempt).toBe(false);
    expect(result.reason).toBe("DOMESTIC_B2B");
    expect(mockClient.setTaxExemption).toHaveBeenCalledWith("checkout-2", false);
    expect(mockClient.updateCheckoutMetadata).toHaveBeenCalledWith("checkout-2", expect.arrayContaining([
      { key: "b2b_reverse_charge", value: "false" },
    ]));
  });

  it("exempts non-EU export", async () => {
    const input: TaxExemptionInput = {
      checkoutId: "checkout-3",
      billingCountryCode: "US",
      vatNumber: null,
      vatValidated: false,
    };

    const result = await executeTaxExemption(input, mockClient);

    expect(result.exempt).toBe(true);
    expect(result.reason).toBe("NON_EU_EXPORT");
    expect(mockClient.setTaxExemption).toHaveBeenCalledWith("checkout-3", true);
  });

  it("handles setTaxExemption failure gracefully", async () => {
    (mockClient.setTaxExemption as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API error"));

    const input: TaxExemptionInput = {
      checkoutId: "checkout-4",
      billingCountryCode: "DE",
      vatNumber: "DE123456789",
      vatValidated: true,
    };

    const result = await executeTaxExemption(input, mockClient);

    expect(result.exempt).toBe(true);
    expect(result.metadataUpdated).toBe(false);
  });

  it("handles metadata update failure gracefully", async () => {
    (mockClient.updateCheckoutMetadata as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Metadata error"));

    const input: TaxExemptionInput = {
      checkoutId: "checkout-5",
      billingCountryCode: "DE",
      vatNumber: "DE123456789",
      vatValidated: true,
    };

    const result = await executeTaxExemption(input, mockClient);

    expect(result.exempt).toBe(true);
    expect(result.metadataUpdated).toBe(false);
    // setTaxExemption should still have been called
    expect(mockClient.setTaxExemption).toHaveBeenCalled();
  });
});
