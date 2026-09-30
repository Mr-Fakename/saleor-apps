import { describe, expect, it } from "vitest";

import { ALLOWED_IBANS } from "./allowed-ibans";
import { findIbans, hashIban, isValidIban, maskIban, normalizeIban } from "./iban";

const SHOP_IBAN = "FR7610206000329873977946448";
// Published specimen IBANs — checksum-valid, belong to nobody.
const GERMAN_SPECIMEN = "DE89370400440532013000";
const FRENCH_SPECIMEN = "FR7630006000011234567890189";
const UK_SPECIMEN = "GB82WEST12345698765432";

describe("isValidIban", () => {
  it.each([SHOP_IBAN, GERMAN_SPECIMEN, FRENCH_SPECIMEN, UK_SPECIMEN])("accepts %s", (iban) => {
    expect(isValidIban(iban)).toBe(true);
  });

  it("accepts the grouped, lowercase form", () => {
    expect(isValidIban("fr76 1020 6000 3298 7397 7946 448")).toBe(true);
  });

  it("rejects a wrong check digit", () => {
    expect(isValidIban("FR7710206000329873977946448")).toBe(false);
  });

  it("rejects a length that does not match the country", () => {
    expect(isValidIban(`${GERMAN_SPECIMEN}0`)).toBe(false);
  });

  it("rejects a country that has no IBAN", () => {
    expect(isValidIban("US12345678901234567890")).toBe(false);
  });
});

describe("hashIban / maskIban", () => {
  it("hashes the normalized form, so formatting does not change the pin", () => {
    expect(hashIban("fr76 1020 6000 3298 7397 7946 448")).toBe(hashIban(SHOP_IBAN));
  });

  it("pins the shop's account in the allowlist", () => {
    expect(ALLOWED_IBANS.map((entry) => entry.sha256)).toContain(hashIban(SHOP_IBAN));
  });

  it("masks to country, check digits and last four", () => {
    expect(maskIban(SHOP_IBAN)).toBe("FR76…6448");
  });

  it("normalizes spaces, dashes, dots and case", () => {
    expect(normalizeIban(" fr76-1020.6000 3298 ")).toBe("FR76102060003298");
  });
});

describe("findIbans", () => {
  it("finds an IBAN printed in groups of four inside a sentence", () => {
    expect(findIbans("Merci de virer sur IBAN : FR76 1020 6000 3298 7397 7946 448. BIC AGRIFRPP802")).toEqual([
      SHOP_IBAN,
    ]);
  });

  it("finds a compact IBAN", () => {
    expect(findIbans(`IBAN:${GERMAN_SPECIMEN}`)).toEqual([GERMAN_SPECIMEN]);
  });

  it("finds lowercase, dashed and double-spaced forms", () => {
    expect(findIbans("de89-3704-0044-0532-0130-00")).toEqual([GERMAN_SPECIMEN]);
    expect(findIbans("DE89  3704  0044  0532  0130  00")).toEqual([GERMAN_SPECIMEN]);
  });

  it("sees through non-breaking spaces and invisible characters", () => {
    expect(findIbans("DE89 3704​0044 0532﻿0130­00")).toEqual([
      GERMAN_SPECIMEN,
    ]);
  });

  it("does not let a leading code swallow the IBAN that follows it", () => {
    expect(findIbans(`Ref AB12 ${GERMAN_SPECIMEN}`)).toEqual([GERMAN_SPECIMEN]);
  });

  it("returns each IBAN once, even when repeated", () => {
    expect(findIbans(`${UK_SPECIMEN} and again ${UK_SPECIMEN}`)).toEqual([UK_SPECIMEN]);
  });

  it("finds several different IBANs", () => {
    expect(findIbans(`${SHOP_IBAN} / ${FRENCH_SPECIMEN}`)).toEqual([SHOP_IBAN, FRENCH_SPECIMEN]);
  });

  it("ignores checksum-invalid lookalikes", () => {
    expect(findIbans("FR77 1020 6000 3298 7397 7946 448")).toEqual([]);
  });

  it.each([
    "Suivi : 6A12345678901",
    "Colis LB123456789FR expédié",
    "Commande n°1096, total 257,90 €",
    "Code postal 59000, tél. +33 6 63 65 72 70",
    "SKU DY-1 / SY-1 / G2+",
  ])("finds nothing in ordinary order text: %s", (text) => {
    expect(findIbans(text)).toEqual([]);
  });
});
