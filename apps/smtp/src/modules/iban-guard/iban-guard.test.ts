import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyIbanGuard,
  findUnknownIbans,
  getIbanGuardMode,
  IbanGuardAlert,
  resetIbanGuardAlertBudget,
} from "./iban-guard";

const SHOP_IBAN_GROUPED = "FR76 1020 6000 3298 7397 7946 448";
const FOREIGN_IBAN = "DE89370400440532013000";
const FOREIGN_IBAN_GROUPED = "DE89 3704 0044 0532 0130 00";

const bankTransferHtml = (iban: string) => `
  <table>
    <tr><td>Titulaire</td><td>M. DESMET ANTOINE</td></tr>
    <tr><td>IBAN</td><td style="font-family:monospace">${iban}</td></tr>
    <tr><td>BIC</td><td>AGRIFRPP802</td></tr>
  </table>`;

describe("getIbanGuardMode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to monitor", () => {
    vi.stubEnv("IBAN_GUARD_MODE", "");

    expect(getIbanGuardMode()).toBe("monitor");
  });

  it.each(["enforce", "off", " ENFORCE "])("reads %s", (value) => {
    vi.stubEnv("IBAN_GUARD_MODE", value);

    expect(getIbanGuardMode()).toBe(value.trim().toLowerCase());
  });

  it("treats an unknown value as monitor, never as off", () => {
    vi.stubEnv("IBAN_GUARD_MODE", "disabled");

    expect(getIbanGuardMode()).toBe("monitor");
  });
});

describe("findUnknownIbans", () => {
  it("lets the shop's own IBAN through", () => {
    expect(
      findUnknownIbans({
        to: "customer@test.com",
        subject: "Votre commande 1096 — instructions de virement",
        html: bankTransferHtml(SHOP_IBAN_GROUPED),
        text: `IBAN ${SHOP_IBAN_GROUPED}`,
      }),
    ).toEqual([]);
  });

  it("reports a foreign IBAN in the HTML", () => {
    expect(
      findUnknownIbans({
        to: "customer@test.com",
        subject: "Votre commande",
        html: bankTransferHtml(FOREIGN_IBAN_GROUPED),
      }),
    ).toEqual([FOREIGN_IBAN]);
  });

  it("reports a foreign IBAN split by inline tags or hidden as entities", () => {
    expect(
      findUnknownIbans({
        to: "c@test.com",
        subject: "x",
        html: "<p>DE89 <b>3704</b> 0044 <span>0532</span> 0130 00</p>",
      }),
    ).toEqual([FOREIGN_IBAN]);
    expect(
      findUnknownIbans({
        to: "c@test.com",
        subject: "x",
        html: "<p>&#68;&#69;89370400440532013000</p>",
      }),
    ).toEqual([FOREIGN_IBAN]);
  });

  it("reports a foreign IBAN in the subject or the text part", () => {
    expect(findUnknownIbans({ to: "c@test.com", subject: `Nouvel IBAN ${FOREIGN_IBAN}` })).toEqual([
      FOREIGN_IBAN,
    ]);
    expect(
      findUnknownIbans({ to: "c@test.com", subject: "x", text: `Virez sur ${FOREIGN_IBAN}` }),
    ).toEqual([FOREIGN_IBAN]);
  });

  it("ignores what the reader cannot see: link targets, image sources, URLs in the text part", () => {
    expect(
      findUnknownIbans({
        to: "c@test.com",
        subject: "Réinitialisez votre mot de passe",
        html: `<a href="https://shop.test/reset?t=${FOREIGN_IBAN}">Réinitialiser</a><img src="https://cdn.test/${FOREIGN_IBAN}.png">`,
        text: `Réinitialiser : https://shop.test/reset?t=${FOREIGN_IBAN}`,
      }),
    ).toEqual([]);
  });

  it("scans fields that are not strings instead of throwing", () => {
    expect(
      findUnknownIbans({
        to: "c@test.com",
        subject: ["Nouvel IBAN"] as unknown as string,
        html: `<p>${FOREIGN_IBAN}</p>`,
      }),
    ).toEqual([FOREIGN_IBAN]);
  });
});

describe("applyIbanGuard", () => {
  const foreignEmail = {
    to: "customer@test.com",
    subject: "Changement de coordonnées bancaires",
    html: bankTransferHtml(FOREIGN_IBAN_GROUPED),
  };

  let sendAlert: ReturnType<typeof vi.fn<(alert: IbanGuardAlert) => Promise<unknown>>>;

  beforeEach(() => {
    resetIbanGuardAlertBudget();
    sendAlert = vi.fn(async () => ({}));
    vi.stubEnv("IBAN_GUARD_ALERT_TO", "owner@shop.test, dev@shop.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("monitor mode: lets the email through but alerts", async () => {
    vi.stubEnv("IBAN_GUARD_MODE", "monitor");

    const verdict = await applyIbanGuard({ email: foreignEmail, source: "api/send", sendAlert });

    expect(verdict).toEqual({ blocked: false, unknownIbans: [FOREIGN_IBAN] });
    expect(sendAlert).toHaveBeenCalledOnce();

    const alert = sendAlert.mock.calls[0][0];

    expect(alert.to).toBe("owner@shop.test, dev@shop.test");
    expect(alert.subject).toContain("détecté");
    expect(alert.text).toContain("ENVOYÉ");
    expect(alert.text).toContain(FOREIGN_IBAN_GROUPED);
    expect(alert.text).toContain("customer@test.com");
    expect(alert.text).toContain("api/send");
  });

  it("enforce mode: blocks the email and alerts", async () => {
    vi.stubEnv("IBAN_GUARD_MODE", "enforce");

    const verdict = await applyIbanGuard({ email: foreignEmail, source: "api/send", sendAlert });

    expect(verdict.blocked).toBe(true);
    expect(sendAlert.mock.calls[0][0].subject).toContain("bloqué");
    expect(sendAlert.mock.calls[0][0].text).toContain("BLOQUÉ");
  });

  it("enforce mode: never blocks mail that has no foreign IBAN", async () => {
    vi.stubEnv("IBAN_GUARD_MODE", "enforce");

    const shopEmail = await applyIbanGuard({
      email: { ...foreignEmail, html: bankTransferHtml(SHOP_IBAN_GROUPED) },
      source: "api/send",
      sendAlert,
    });
    const passwordReset = await applyIbanGuard({
      email: {
        to: "customer@test.com",
        subject: "Réinitialisation du mot de passe",
        html: '<p>Cliquez <a href="https://shop.test/reset?token=cs5x2k-3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c">ici</a>.</p>',
      },
      source: "event:ACCOUNT_PASSWORD_RESET",
      sendAlert,
    });

    expect(shopEmail.blocked).toBe(false);
    expect(passwordReset.blocked).toBe(false);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("off mode: does not scan", async () => {
    vi.stubEnv("IBAN_GUARD_MODE", "off");

    const verdict = await applyIbanGuard({ email: foreignEmail, source: "api/send", sendAlert });

    expect(verdict).toEqual({ blocked: false, unknownIbans: [] });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("still returns the verdict when the alert cannot be sent", async () => {
    vi.stubEnv("IBAN_GUARD_MODE", "enforce");
    sendAlert.mockRejectedValue(new Error("SMTP down"));

    const verdict = await applyIbanGuard({ email: foreignEmail, source: "api/send", sendAlert });

    expect(verdict.blocked).toBe(true);
  });

  it("does not try to alert when no recipient is configured", async () => {
    vi.stubEnv("IBAN_GUARD_ALERT_TO", "");

    await applyIbanGuard({ email: foreignEmail, source: "api/send", sendAlert });

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("caps alert mail at 10 per hour, but keeps judging every email", async () => {
    vi.stubEnv("IBAN_GUARD_MODE", "enforce");

    const verdicts = [];

    for (let i = 0; i < 12; i++) {
      verdicts.push(await applyIbanGuard({ email: foreignEmail, source: "api/send", sendAlert }));
    }

    expect(sendAlert).toHaveBeenCalledTimes(10);
    expect(verdicts.every((verdict) => verdict.blocked)).toBe(true);
  });
});
