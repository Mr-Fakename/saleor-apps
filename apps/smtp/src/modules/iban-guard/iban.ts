import { createHash } from "node:crypto";

/**
 * IBAN length per country, from the SWIFT IBAN registry. Only these countries are
 * recognized: a two-letter prefix outside this table is not treated as an IBAN, which
 * keeps random codes (tracking numbers, SKUs) from being mistaken for one.
 */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21,
  LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
  NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22,
  RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25,
  SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

// Zero-width and soft-hyphen characters an attacker could slip between digits to
// break a naive match without changing what the reader sees.
const INVISIBLE_CHARS = /[­​-‍⁠﻿]/g;
// Any Unicode space (NBSP, thin space, ...) is read as a plain space.
const UNICODE_SPACES = /[   -   　]/g;
// Separators people print IBANs with: "FR76 3000 6000 ..." or "FR76-3000-...".
const SEPARATOR = /[ \t\r\n\-.]/;
// "FR76  3000" (double space, or " - ") still reads as one IBAN to a person.
const MAX_SEPARATOR_RUN = 3;
const ALNUM = /[A-Z0-9]/;
// A candidate starts with country + check digits, not glued to a preceding letter/digit.
const IBAN_START = /(?<![A-Z0-9])[A-Z]{2}[0-9]{2}/g;

export const normalizeIban = (raw: string): string =>
  raw.replace(INVISIBLE_CHARS, "").replace(/[\s\-.]/g, "").toUpperCase();

/** ISO 7064 mod-97 check plus the country's registered length. */
export const isValidIban = (raw: string): boolean => {
  const iban = normalizeIban(raw);
  const expectedLength = IBAN_LENGTHS[iban.slice(0, 2)];

  if (!expectedLength || iban.length !== expectedLength || !/^[A-Z0-9]+$/.test(iban)) {
    return false;
  }

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;

  // The number is far beyond Number.MAX_SAFE_INTEGER, so reduce digit by digit.
  for (const d of digits) {
    remainder = (remainder * 10 + Number(d)) % 97;
  }

  return remainder === 1;
};

export const hashIban = (raw: string): string =>
  createHash("sha256").update(normalizeIban(raw)).digest("hex");

/** "FR76…6448" — enough to recognize an account without repeating it in full. */
export const maskIban = (raw: string): string => {
  const iban = normalizeIban(raw);

  return `${iban.slice(0, 4)}…${iban.slice(-4)}`;
};

/**
 * Returns every checksum-valid IBAN found in human-readable text, normalized and
 * de-duplicated. Tolerates the ways an IBAN is usually printed (grouped by four,
 * dashes, lowercase, non-breaking spaces) and the invisible characters that could be
 * used to dodge a plain regex.
 */
export const findIbans = (content: string): string[] => {
  const text = content
    .normalize("NFKC")
    .replace(INVISIBLE_CHARS, "")
    .replace(UNICODE_SPACES, " ")
    .toUpperCase();
  const found = new Set<string>();

  for (const match of text.matchAll(IBAN_START)) {
    const expectedLength = IBAN_LENGTHS[match[0].slice(0, 2)];

    if (!expectedLength) {
      continue;
    }

    let candidate = "";
    let separatorRun = 0;

    for (
      let i = match.index ?? 0;
      i < text.length && candidate.length < expectedLength;
      i++
    ) {
      const char = text[i];

      if (ALNUM.test(char)) {
        candidate += char;
        separatorRun = 0;
      } else if (SEPARATOR.test(char) && separatorRun < MAX_SEPARATOR_RUN) {
        // A short gap between groups is formatting; a longer one ends the IBAN.
        separatorRun++;
      } else {
        break;
      }
    }

    if (candidate.length === expectedLength && isValidIban(candidate)) {
      found.add(candidate);
    }
  }

  return [...found];
};
