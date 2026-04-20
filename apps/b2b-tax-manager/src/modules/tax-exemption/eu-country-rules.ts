import { isEuCountry } from "../vat-validation/vat-patterns";

const SELLER_COUNTRY = "FR";

export type TaxExemptionReason =
  | "INTRA_EU_REVERSE_CHARGE"
  | "NON_EU_EXPORT"
  | "DOMESTIC_B2B"
  | "INTRA_EU_NO_VALID_VAT"
  | "DOMESTIC_B2C";

export type TaxExemptionDenialReason =
  | "BILLING_COUNTRY_MISMATCH"
  | "DOMESTIC_DELIVERY"
  | "COMPANY_NAME_MISSING";

export interface TaxExemptionResult {
  exempt: boolean;
  reason: TaxExemptionReason;
  denied?: TaxExemptionDenialReason;
}

/**
 * Evaluate tax exemption with anti-fraud checks.
 *
 * Three layers of defense:
 * 1. VAT country must match billing country (prevents using someone else's foreign VAT)
 * 2. Shipping to seller country = no reverse charge (goods must leave FR for intra-community supply)
 * 3. Standard EU VAT rules (domestic, intra-EU, non-EU)
 */
export function evaluateTaxExemption(
  vatCountryCode: string,
  vatValidated: boolean,
  billingCountryCode?: string,
  shippingCountryCode?: string,
): TaxExemptionResult {
  const vatCountry = vatCountryCode.toUpperCase();
  const billingCountry = billingCountryCode?.toUpperCase() || vatCountry;
  const shippingCountry = shippingCountryCode?.toUpperCase();
  const isDomestic = vatCountry === SELLER_COUNTRY;
  const isEu = isEuCountry(vatCountry);

  // Non-EU: always zero-rated export
  if (!isEu) {
    return { exempt: true, reason: "NON_EU_EXPORT" };
  }

  // Domestic (FR): never exempt, regardless of VAT
  if (isDomestic) {
    return {
      exempt: false,
      reason: vatValidated ? "DOMESTIC_B2B" : "DOMESTIC_B2C",
    };
  }

  // Intra-EU: exempt only if VAT is VIES-validated AND anti-fraud checks pass
  if (vatValidated) {
    // Anti-fraud #1: Billing country must match VAT registration country.
    // A DE VAT number with a FR billing address is suspicious —
    // the buyer should provide their business address in DE.
    if (billingCountry !== vatCountry) {
      return {
        exempt: false,
        reason: "INTRA_EU_NO_VALID_VAT",
        denied: "BILLING_COUNTRY_MISMATCH",
      };
    }

    // Anti-fraud #2: Goods shipped to seller country = domestic delivery.
    // Even with a valid DE VAT and DE billing, if goods are shipped to FR,
    // it's not a genuine intra-community supply of goods.
    if (shippingCountry && shippingCountry === SELLER_COUNTRY) {
      return {
        exempt: false,
        reason: "DOMESTIC_B2B",
        denied: "DOMESTIC_DELIVERY",
      };
    }

    return { exempt: true, reason: "INTRA_EU_REVERSE_CHARGE" };
  }

  return { exempt: false, reason: "INTRA_EU_NO_VALID_VAT" };
}
