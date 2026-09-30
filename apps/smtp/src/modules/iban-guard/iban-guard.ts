import { convert } from "html-to-text";

import { createLogger } from "../../logger";
import { ALLOWED_IBANS } from "./allowed-ibans";
import { findIbans, hashIban, maskIban, normalizeIban } from "./iban";

/**
 * Outbound check against IBAN-swap fraud: every email this app sends is scanned for
 * bank account numbers, and any IBAN that is not in ALLOWED_IBANS raises an alert.
 *
 * Modes (env `IBAN_GUARD_MODE`):
 *   - monitor (default): the email still goes out; staff are alerted.
 *   - enforce: the email is not sent; staff are alerted.
 *   - off: no scanning.
 *
 * Only visible text is scanned — link targets and image sources are skipped, because
 * an IBAN only does harm if the reader sees it, and URLs carry long random tokens that
 * could otherwise look like one. Emails without an IBAN are never affected.
 *
 * The guard fails open: if inspection itself throws, the email is sent and the error is
 * logged, so a bug here can never stop login, password-reset or order emails.
 */

export type IbanGuardMode = "enforce" | "monitor" | "off";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

export interface IbanGuardAlert {
  to: string;
  subject: string;
  text: string;
}

export interface IbanGuardVerdict {
  blocked: boolean;
  unknownIbans: string[];
}

const logger = createLogger("IbanGuard");

const ALERT_WINDOW_MS = 60 * 60 * 1000;
// Caps alert mail if someone hammers the endpoint; every hit is still logged.
const MAX_ALERTS_PER_WINDOW = 10;

let alertWindowStart = 0;
let alertsInWindow = 0;

export const resetIbanGuardAlertBudget = () => {
  alertWindowStart = 0;
  alertsInWindow = 0;
};

const takeAlertBudget = (now: number): boolean => {
  if (now - alertWindowStart > ALERT_WINDOW_MS) {
    alertWindowStart = now;
    alertsInWindow = 0;
  }

  alertsInWindow++;

  return alertsInWindow <= MAX_ALERTS_PER_WINDOW;
};

export const getIbanGuardMode = (): IbanGuardMode => {
  const value = process.env.IBAN_GUARD_MODE?.trim().toLowerCase();

  if (value === "enforce" || value === "off") {
    return value;
  }

  return "monitor";
};

const getAlertRecipients = (): string[] =>
  (process.env.IBAN_GUARD_ALERT_TO ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);

const VISIBLE_TEXT_OPTIONS = {
  wordwrap: false as const,
  selectors: [
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" },
  ],
};

/**
 * Two renderings, because each one hides something the other shows:
 *   - as-is: inline tags are joined, so "D<b>E</b>89 3704…" still reads "DE89 3704…";
 *   - with a space before every tag: table cells are kept apart. The converter otherwise
 *     glues "<td>IBAN</td><td>DE89…</td><td>BIC</td>" into one run with no spaces
 *     between the three cells, where the IBAN has no boundary and would be missed.
 *     That is exactly our email's layout.
 */
const htmlToVisibleTexts = (html: string): string[] => {
  try {
    return [
      convert(html, VISIBLE_TEXT_OPTIONS),
      convert(html.replace(/</g, " <"), VISIBLE_TEXT_OPTIONS),
    ];
  } catch {
    // Markup the converter chokes on is still scanned, just more crudely.
    return [html.replace(/<[^>]*>/g, " ")];
  }
};

const stripUrls = (text: string): string => text.replace(/\b(?:https?|mailto):\S+/gi, " ");

const ALLOWED_HASHES = new Set(ALLOWED_IBANS.map((entry) => entry.sha256));

// Callers pass request bodies through; coerce rather than throw, because a throw makes
// the guard fail open and a crafted non-string field must not be a way around it.
const asText = (value: unknown): string =>
  typeof value === "string" ? value : value == null ? "" : String(value);

/** IBANs in the email's visible content that are not on the allowlist. */
export const findUnknownIbans = (email: OutgoingEmail): string[] => {
  const html = asText(email.html);
  const text = asText(email.text);
  // Each part is scanned on its own so an IBAN cannot be stitched across two parts.
  const parts = [asText(email.subject), ...(html ? htmlToVisibleTexts(html) : []), stripUrls(text)];
  const unknown = new Set<string>();

  for (const part of parts) {
    for (const iban of findIbans(part)) {
      if (!ALLOWED_HASHES.has(hashIban(iban))) {
        unknown.add(iban);
      }
    }
  }

  return [...unknown];
};

const formatIban = (iban: string) =>
  normalizeIban(iban)
    .replace(/(.{4})/g, "$1 ")
    .trim();

const buildAlert = ({
  recipients,
  email,
  source,
  blocked,
  unknownIbans,
}: {
  recipients: string[];
  email: OutgoingEmail;
  source: string;
  blocked: boolean;
  unknownIbans: string[];
}): IbanGuardAlert => {
  const action = blocked
    ? "E-mail BLOQUÉ : il n'a pas été envoyé."
    : "E-mail ENVOYÉ (mode surveillance) : il est parti tel quel.";
  const ibanLines = unknownIbans
    .map((iban) => `  ${formatIban(iban)}   (empreinte ${hashIban(iban).slice(0, 12)})`)
    .join("\n");

  return {
    to: recipients.join(", "),
    subject: `[Alerte sécurité] IBAN inconnu ${blocked ? "bloqué" : "détecté"} dans un e-mail sortant`,
    text: [
      "Un e-mail envoyé au nom de la boutique contenait un IBAN qui ne correspond pas",
      "aux coordonnées bancaires enregistrées.",
      "",
      `Action : ${action}`,
      `Origine : ${source}`,
      `Destinataire : ${email.to}`,
      `Objet : ${email.subject}`,
      `Date : ${new Date().toISOString()}`,
      "",
      "IBAN détecté (NE PAS PAYER vers ce compte) :",
      ibanLines,
      "",
      "Si vous n'êtes pas à l'origine de cet envoi, quelqu'un tente peut-être de détourner",
      "les paiements de vos clients. Prévenez votre prestataire technique immédiatement.",
      blocked
        ? ""
        : "L'e-mail est parti : contactez aussi le destinataire pour lui dire de ne pas payer.",
    ].join("\n"),
  };
};

export const applyIbanGuard = async ({
  email,
  source,
  sendAlert,
}: {
  email: OutgoingEmail;
  /** Where the email came from, for the alert: "api/send", "event:ORDER_CREATED", ... */
  source: string;
  sendAlert: (alert: IbanGuardAlert) => Promise<unknown>;
}): Promise<IbanGuardVerdict> => {
  const mode = getIbanGuardMode();

  if (mode === "off") {
    return { blocked: false, unknownIbans: [] };
  }

  let unknownIbans: string[];

  try {
    unknownIbans = findUnknownIbans(email);
  } catch (error) {
    logger.error("IBAN guard could not inspect an email; sending it unchecked", {
      source,
      error: error instanceof Error ? error.message : String(error),
    });

    return { blocked: false, unknownIbans: [] };
  }

  if (unknownIbans.length === 0) {
    return { blocked: false, unknownIbans: [] };
  }

  const blocked = mode === "enforce";

  logger.error(
    blocked
      ? "IBAN guard blocked an email containing an IBAN that is not on the allowlist"
      : "Email contains an IBAN that is not on the allowlist (monitor mode, sent anyway)",
    {
      source,
      mode,
      recipientEmail: email.to,
      emailSubject: email.subject,
      ibans: unknownIbans.map(maskIban),
      ibanHashes: unknownIbans.map(hashIban),
    },
  );

  const recipients = getAlertRecipients();

  if (recipients.length > 0 && takeAlertBudget(Date.now())) {
    try {
      await sendAlert(buildAlert({ recipients, email, source, blocked, unknownIbans }));
    } catch (error) {
      logger.error("IBAN guard failed to send its alert email", {
        source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { blocked, unknownIbans };
};
