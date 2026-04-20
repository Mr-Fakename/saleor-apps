/**
 * EU VAT number regex patterns per country code.
 * Matches the VIES (VAT Information Exchange System) format specification.
 * Each pattern validates the full VAT number INCLUDING the country prefix.
 */
export const vatPatterns: Record<string, RegExp> = {
  AT: /^ATU\d{8}$/, // Austria: U + 8 digits
  BE: /^BE[01]\d{9}$/, // Belgium: 0 or 1 + 9 digits (10 total)
  BG: /^BG\d{9,10}$/, // Bulgaria: 9-10 digits
  HR: /^HR\d{11}$/, // Croatia: 11 digits (OIB)
  CY: /^CY\d{8}[A-Z]$/, // Cyprus: 8 digits + 1 letter
  CZ: /^CZ\d{8,10}$/, // Czech Republic: 8-10 digits
  DK: /^DK\d{8}$/, // Denmark: 8 digits
  EE: /^EE\d{9}$/, // Estonia: 9 digits
  FI: /^FI\d{8}$/, // Finland: 8 digits
  FR: /^FR[A-HJ-NP-Z0-9]{2}\d{9}$/, // France: 2 chars (letter/digit, excl I/O) + 9 digits
  DE: /^DE\d{9}$/, // Germany: 9 digits
  GR: /^EL\d{9}$/, // Greece: EL prefix + 9 digits
  HU: /^HU\d{8}$/, // Hungary: 8 digits
  IE: /^IE(\d{7}[A-Z]{1,2}|\d[A-Z+*]\d{5}[A-Z])$/, // Ireland: complex
  IT: /^IT\d{11}$/, // Italy: 11 digits
  LV: /^LV\d{11}$/, // Latvia: 11 digits
  LT: /^LT(\d{9}|\d{12})$/, // Lithuania: 9 or 12 digits
  LU: /^LU\d{8}$/, // Luxembourg: 8 digits
  MT: /^MT\d{8}$/, // Malta: 8 digits
  NL: /^NL\d{9}B\d{2}$/, // Netherlands: 9 digits + B + 2 digits
  PL: /^PL\d{10}$/, // Poland: 10 digits
  PT: /^PT\d{9}$/, // Portugal: 9 digits
  RO: /^RO\d{2,10}$/, // Romania: 2-10 digits
  SK: /^SK\d{10}$/, // Slovakia: 10 digits
  SI: /^SI\d{8}$/, // Slovenia: 8 digits
  ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/, // Spain: 1 char + 7 digits + 1 char
  SE: /^SE\d{12}$/, // Sweden: 12 digits
};

/**
 * All 27 EU member state country codes.
 */
export const EU_COUNTRY_CODES = Object.keys(vatPatterns);

/**
 * Validates a VAT number against the pattern for its country.
 * Returns the matched country code or null.
 */
export function validateVatFormat(vatNumber: string): {
  valid: boolean;
  countryCode: string | null;
} {
  const cleaned = vatNumber.replace(/[\s.-]/g, "").toUpperCase();

  for (const [code, pattern] of Object.entries(vatPatterns)) {
    // Greece uses EL prefix but country code is GR
    const prefix = code === "GR" ? "EL" : code;
    if (cleaned.startsWith(prefix) && pattern.test(cleaned)) {
      return { valid: true, countryCode: code };
    }
  }

  return { valid: false, countryCode: null };
}

/**
 * Checks if a country code belongs to an EU member state.
 */
export function isEuCountry(countryCode: string): boolean {
  return EU_COUNTRY_CODES.includes(countryCode.toUpperCase());
}
