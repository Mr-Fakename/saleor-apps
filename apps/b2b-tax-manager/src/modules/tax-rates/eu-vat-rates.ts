/**
 * Standard VAT rates for all 27 EU member states (2026).
 *
 * Sources:
 * - Tax Foundation (taxfoundation.org/data/all/eu/value-added-tax-vat-rates-europe/)
 * - ASD Group (asd-int.com/en/vat-rates-2026-in-europe/)
 *
 * Notable 2025-2026 changes:
 * - Estonia: 22% → 24% (July 2025)
 * - Finland: 24% → 25.5% (September 2024)
 * - Romania: 19% → 21% (August 2025, provisional — pending final confirmation)
 * - Slovakia: 20% → 23% (January 2025)
 *
 * These are standard rates only. Reduced/super-reduced rates exist but are
 * product-category-specific and managed via Saleor TaxClass assignments.
 */
export const EU_STANDARD_VAT_RATES: Record<string, number> = {
  AT: 20,    // Austria
  BE: 21,    // Belgium
  BG: 20,    // Bulgaria
  HR: 25,    // Croatia
  CY: 19,    // Cyprus
  CZ: 21,    // Czech Republic
  DK: 25,    // Denmark
  EE: 24,    // Estonia (increased from 22%, July 2025)
  FI: 25.5,  // Finland (increased from 24%, September 2024)
  FR: 20,    // France
  DE: 19,    // Germany
  GR: 24,    // Greece
  HU: 27,    // Hungary (highest in EU)
  IE: 23,    // Ireland
  IT: 22,    // Italy
  LV: 21,    // Latvia
  LT: 21,    // Lithuania
  LU: 17,    // Luxembourg (lowest in EU)
  MT: 18,    // Malta
  NL: 21,    // Netherlands
  PL: 23,    // Poland
  PT: 23,    // Portugal
  RO: 21,    // Romania (increased from 19%, August 2025)
  SK: 23,    // Slovakia (increased from 20%, January 2025)
  SI: 22,    // Slovenia
  ES: 21,    // Spain
  SE: 25,    // Sweden
};

/**
 * Get the standard VAT rate for an EU country.
 * Returns undefined for non-EU countries.
 */
export function getStandardVatRate(countryCode: string): number | undefined {
  return EU_STANDARD_VAT_RATES[countryCode.toUpperCase()];
}

/**
 * Get the seller's (France) standard VAT rate.
 */
export const SELLER_VAT_RATE = EU_STANDARD_VAT_RATES.FR; // 20%
