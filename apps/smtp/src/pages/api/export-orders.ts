import { NextApiHandler } from "next";
import nodemailer from "nodemailer";
import { Pool } from "pg";

import { createLogger } from "../../logger";

const logger = createLogger("api/export-orders");

/**
 * On-demand order export: queries Postgres directly, builds a CSV and emails it
 * as an attachment. Triggered two ways:
 *   1. The store owner, via a private authenticated URL (?key=... clickable link).
 *   2. Optionally the daily Dokploy cron, via a one-line `curl` to this route.
 *
 * Auth: a dedicated `ORDER_EXPORT_API_KEY` (NOT the email-bridge secret), passed
 * as `?key=` (so it works as a bookmark) or the `X-API-Key` header.
 *
 * The SQL below is the canonical copy. `scripts/weekly-order-export.sh` keeps a
 * standalone duplicate for the psql-in-db-container fallback — keep them in sync.
 * Column order + the `AS` aliases become the CSV header row (matches `psql --csv`).
 */
const ORDER_EXPORT_SQL = `
SELECT
  o.number                                        AS "N commande",
  TO_CHAR(o.created_at, 'YYYY-MM-DD HH24:MI:SS') AS "Date de commande",
  o.status                                        AS "Statut",

  CASE
    WHEN ti.payment_method_type = 'card'
      THEN 'Carte ' || COALESCE(INITCAP(ti.payment_method_name), '')
    WHEN ti.payment_method_name IS NOT NULL
      THEN INITCAP(ti.payment_method_name)
    ELSE ''
  END                                             AS "Mode de paiement",
  COALESCE(ti.psp_reference, '')                  AS "Reference PSP",

  COALESCE(ol.product_sku, '')                    AS "SKU",
  ol.product_name                                 AS "Article",
  CASE
    WHEN ol.metadata->>'configurator_type' = 'cable'
      THEN COALESCE(NULLIF(ol.metadata->>'variant_name', ''), ol.variant_name)
    ELSE ol.variant_name
  END                                             AS "Declinaison",
  ol.quantity                                     AS "Quantite",

  CASE WHEN ol.metadata->>'configurator_type' = 'cable'
    THEN 'Oui' ELSE ''
  END                                             AS "Cable personnalise",
  COALESCE(ol.metadata->>'connecteur_1_name', '') AS "Cable - Connecteur 1",
  COALESCE(ol.metadata->>'connecteur_2_name', '') AS "Cable - Connecteur 2",
  COALESCE(ol.metadata->>'connecteur_3_name', '') AS "Cable - Connecteur 3",
  COALESCE(ol.metadata->>'type_cable_name', '')   AS "Cable - Type",
  COALESCE(ol.metadata->>'couleur_cable_name', '') AS "Cable - Couleur",
  COALESCE(ol.metadata->>'reference_gaine_name', '') AS "Cable - Gaine",
  COALESCE(ol.metadata->>'direction_cable_name', '') AS "Cable - Direction",
  CASE WHEN ol.metadata ? 'longueur_cable_cm'
    THEN (ol.metadata->>'longueur_cable_cm') || ' cm'
    ELSE ''
  END                                             AS "Cable - Longueur",
  CASE WHEN ol.metadata->>'configurator_type' = 'cable'
    THEN CONCAT_WS(' | ',
      'Assemblage: '   || (ol.metadata->>'component_assembly_price'),
      'Connecteur 1: ' || (ol.metadata->>'component_connector1_price'),
      'Connecteur 2: ' || (ol.metadata->>'component_connector2_price'),
      'Connecteur 3: ' || (ol.metadata->>'component_connector3_price'),
      'Gaine: '        || (ol.metadata->>'component_gaine_price'),
      'Cable: '        || (ol.metadata->>'component_length_price')
                       || ' (' || (ol.metadata->>'component_cable_price') || '/m)',
      'Total: '        || (ol.metadata->>'total_price')
                       || ' ' || COALESCE(ol.metadata->>'currency', '')
    )
    ELSE ''
  END                                             AS "Cable - Detail prix",

  ol.unit_price_net_amount                        AS "Prix unitaire HT",
  ol.unit_price_gross_amount                      AS "Prix unitaire TTC",
  ol.undiscounted_unit_price_net_amount            AS "Prix unitaire HT avant remise",
  ol.undiscounted_unit_price_gross_amount          AS "Prix unitaire TTC avant remise",

  ol.total_price_net_amount                       AS "Total ligne HT",
  ol.total_price_gross_amount                     AS "Total ligne TTC",

  ROUND(ol.tax_rate * 100, 2)                     AS "TVA pct",

  o.shipping_price_net_amount                     AS "Frais de port HT",
  o.shipping_price_gross_amount                   AS "Frais de port TTC",
  ROUND(o.shipping_tax_rate * 100, 2)             AS "TVA port pct",
  COALESCE(o.shipping_method_name, '')            AS "Methode de livraison",

  COALESCE(refunds.total_refund, 0)               AS "Montant rembourse",

  o.currency                                      AS "Devise",

  COALESCE(TO_CHAR(f_data.fulfilled_at, 'YYYY-MM-DD HH24:MI:SS'), '')
                                                  AS "Date envoi",
  COALESCE(f_data.tracking, '')                   AS "N suivi",

  COALESCE(ba.company_name, '')                   AS "Entreprise facturation",
  COALESCE(ba.last_name, '')                      AS "Nom facturation",
  COALESCE(ba.first_name, '')                     AS "Prenom facturation",
  COALESCE(ba.street_address_1, '')               AS "Rue facturation",
  COALESCE(ba.street_address_2, '')               AS "Complement adresse facturation",
  COALESCE(ba.postal_code, '')                    AS "Code postal facturation",
  COALESCE(ba.city, '')                           AS "Ville facturation",
  COALESCE(ba.country_area, '')                   AS "Region facturation",
  CASE ba.country
    WHEN 'FR' THEN 'France'    WHEN 'BE' THEN 'Belgique'
    WHEN 'CH' THEN 'Suisse'    WHEN 'LU' THEN 'Luxembourg'
    WHEN 'DE' THEN 'Allemagne' WHEN 'ES' THEN 'Espagne'
    WHEN 'IT' THEN 'Italie'    WHEN 'NL' THEN 'Pays-Bas'
    WHEN 'GB' THEN 'Royaume-Uni' WHEN 'US' THEN 'Etats-Unis'
    WHEN 'PT' THEN 'Portugal'  WHEN 'AT' THEN 'Autriche'
    ELSE COALESCE(ba.country, '')
  END                                             AS "Pays facturation",
  COALESCE(ba.phone, '')                          AS "Telephone facturation",
  o.user_email                                    AS "Email facturation",

  COALESCE(
    NULLIF(o.metadata->>'b2b_buyer_vat_number', ''),
    o.metadata->>'b2b_vat_number',
    ''
  )                                               AS "N TVA intracommunautaire",
  CASE WHEN o.metadata->>'b2b_reverse_charge' = 'true'
    THEN 'Oui' ELSE ''
  END                                             AS "Autoliquidation TVA",

  COALESCE(sa.company_name, '')                   AS "Entreprise livraison",
  COALESCE(sa.last_name, '')                      AS "Nom livraison",
  COALESCE(sa.first_name, '')                     AS "Prenom livraison",
  COALESCE(sa.street_address_1, '')               AS "Rue livraison",
  COALESCE(sa.street_address_2, '')               AS "Complement adresse livraison",
  COALESCE(sa.postal_code, '')                    AS "Code postal livraison",
  COALESCE(sa.city, '')                           AS "Ville livraison",
  COALESCE(sa.country_area, '')                   AS "Region livraison",
  CASE sa.country
    WHEN 'FR' THEN 'France'    WHEN 'BE' THEN 'Belgique'
    WHEN 'CH' THEN 'Suisse'    WHEN 'LU' THEN 'Luxembourg'
    WHEN 'DE' THEN 'Allemagne' WHEN 'ES' THEN 'Espagne'
    WHEN 'IT' THEN 'Italie'    WHEN 'NL' THEN 'Pays-Bas'
    WHEN 'GB' THEN 'Royaume-Uni' WHEN 'US' THEN 'Etats-Unis'
    WHEN 'PT' THEN 'Portugal'  WHEN 'AT' THEN 'Autriche'
    ELSE COALESCE(sa.country, '')
  END                                             AS "Pays livraison",
  COALESCE(sa.phone, '')                          AS "Telephone livraison",

  -- Collapse CR/LF/tabs in the free-text note to single spaces so each order
  -- line stays one row (kept in sync with scripts/weekly-order-export.sh).
  -- toCsv() already RFC-4180-quotes it, but a bare CR from a pasted note can
  -- still split a record in Excel — flattening removes that class of failure.
  TRIM(regexp_replace(COALESCE(o.customer_note, ''), '[\r\n\t]+', ' ', 'g'))
                                                  AS "Note client",
  COALESCE(o.voucher_code, '')                    AS "Code promo",
  COALESCE(u.id::text, '')                        AS "N client"

FROM order_order o
JOIN order_orderline ol ON ol.order_id = o.id
LEFT JOIN account_address ba ON ba.id = o.billing_address_id
LEFT JOIN account_address sa ON sa.id = o.shipping_address_id
LEFT JOIN account_user u ON u.id = o.user_id
LEFT JOIN LATERAL (
  SELECT payment_method_type, payment_method_name, psp_reference
  FROM payment_transactionitem pti
  WHERE pti.order_id = o.id
  ORDER BY pti.created_at DESC LIMIT 1
) ti ON true
LEFT JOIN LATERAL (
  SELECT created_at AS fulfilled_at, tracking_number AS tracking
  FROM order_fulfillment f
  WHERE f.order_id = o.id AND f.status = 'fulfilled'
  ORDER BY f.created_at DESC LIMIT 1
) f_data ON true
LEFT JOIN LATERAL (
  SELECT SUM(amount_value) AS total_refund
  FROM order_ordergrantedrefund r
  WHERE r.order_id = o.id AND r.status <> 'failure'
) refunds ON true
WHERE o.status NOT IN ('draft', 'unconfirmed')
  AND o.created_at >= NOW() - ($1::int * INTERVAL '1 day')
ORDER BY o.created_at, o.number, ol.created_at
`;

// Reused Postgres pool (this app runs as a long-lived `next start` server).
let pool: Pool | null = null;

const getPool = (): Pool => {
  if (!pool) {
    const connectionString = process.env.ORDER_EXPORT_DATABASE_URL;

    if (!connectionString) {
      throw new Error("ORDER_EXPORT_DATABASE_URL is not configured");
    }

    pool = new Pool({ connectionString, max: 2, statement_timeout: 30_000 });
  }

  return pool;
};

// RFC 4180 CSV serialization (mirrors psql --csv: quote fields containing a
// comma, double-quote, CR or LF; escape inner quotes by doubling them).
const toCsv = (fields: string[], rows: Array<Record<string, unknown>>): string => {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) {
      return "";
    }

    const str = String(value);

    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }

    return str;
  };

  const header = fields.map(escape).join(",");
  const lines = rows.map(row => fields.map(field => escape(row[field])).join(","));

  return [header, ...lines].join("\r\n");
};

const parseDays = (raw: unknown): number => {
  const value = typeof raw === "string" ? parseInt(raw, 10) : 1;

  if (!Number.isFinite(value) || value < 1 || value > 366) {
    return 1;
  }

  return value;
};

const handler: NextApiHandler = async (req, res) => {
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // --- Authentication ---
  const expectedKey = process.env.ORDER_EXPORT_API_KEY;

  if (!expectedKey) {
    logger.error("ORDER_EXPORT_API_KEY is not configured");

    return res.status(500).json({ error: "Export endpoint not configured" });
  }

  const headerKey = req.headers["x-api-key"];
  const queryKey = typeof req.query.key === "string" ? req.query.key : undefined;
  const providedKey = (typeof headerKey === "string" ? headerKey : undefined) ?? queryKey;

  if (!providedKey || providedKey !== expectedKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // --- Inputs ---
  const days = parseDays(req.query.days);
  const recipient =
    (typeof req.query.to === "string" && req.query.to) || process.env.ORDER_EXPORT_RECIPIENT;

  if (!recipient) {
    logger.error("ORDER_EXPORT_RECIPIENT is not configured and no ?to= provided");

    return res.status(500).json({ error: "Recipient not configured" });
  }

  // --- SMTP config ---
  // Prefer dedicated ORDER_EXPORT_SMTP_* so the export goes through a REAL relay
  // (e.g. smtp.porkbun.com:587, same as the cron script). The EMAIL_BRIDGE_SMTP_*
  // fallback exists for parity with /api/send, but in prod that points at mailpit
  // (port 1025 = caught, not delivered) — set the ORDER_EXPORT_SMTP_* vars for the
  // email to actually reach the client. PASS/PASSWORD and FROM variants are both
  // accepted because the compose and the code historically disagree on the names.
  const smtpHost = process.env.ORDER_EXPORT_SMTP_HOST || process.env.EMAIL_BRIDGE_SMTP_HOST;

  if (!smtpHost) {
    logger.error("No SMTP host configured (ORDER_EXPORT_SMTP_HOST / EMAIL_BRIDGE_SMTP_HOST)");

    return res.status(500).json({ error: "SMTP not configured" });
  }

  const smtpPort = parseInt(
    process.env.ORDER_EXPORT_SMTP_PORT || process.env.EMAIL_BRIDGE_SMTP_PORT || "587",
    10,
  );
  const smtpSecure =
    (process.env.ORDER_EXPORT_SMTP_SECURE || process.env.EMAIL_BRIDGE_SMTP_SECURE) === "true";
  const smtpUser = process.env.ORDER_EXPORT_SMTP_USER || process.env.EMAIL_BRIDGE_SMTP_USER;
  const smtpPass =
    process.env.ORDER_EXPORT_SMTP_PASS ||
    process.env.ORDER_EXPORT_SMTP_PASSWORD ||
    process.env.EMAIL_BRIDGE_SMTP_PASS ||
    process.env.EMAIL_BRIDGE_SMTP_PASSWORD;
  const smtpFrom =
    process.env.ORDER_EXPORT_SMTP_FROM ||
    process.env.EMAIL_BRIDGE_SMTP_FROM ||
    process.env.EMAIL_BRIDGE_FROM ||
    smtpUser;

  try {
    const result = await getPool().query<Record<string, unknown>>({
      text: ORDER_EXPORT_SQL,
      values: [days],
    });

    const lineCount = result.rows.length;

    // "Once a day IF there are orders, else nothing" — skip the email silently.
    if (lineCount === 0) {
      logger.info("Order export: no orders in window, skipping email", { days });

      return res.status(200).json({ success: true, sent: false, reason: "no-orders", lines: 0 });
    }

    const fields = result.fields.map(field => field.name);
    const csv = toCsv(fields, result.rows);
    const cableLines = result.rows.filter(row => row["Cable personnalise"] === "Oui").length;

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `commandes_saleor_${dateStr}.csv`;
    const subject = `Export commandes Dess - journee du ${dateStr}`;
    const periodLabel = days === 1 ? "dernieres 24 heures" : `derniers ${days} jours`;
    const html =
      `<p>Bonjour,</p>` +
      `<p>Veuillez trouver ci-joint l'export des commandes (${periodLabel}).</p>` +
      `<p>Lignes exportees : ${lineCount}<br/>Dont cables personnalises : ${cableLines}</p>`;

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      requireTLS: !smtpSecure,
      tls: { minVersion: "TLSv1.2" },
      auth: smtpUser
        ? {
            user: smtpUser,
            pass: smtpPass,
          }
        : undefined,
    });

    const info = await transporter.sendMail({
      from: smtpFrom,
      to: recipient,
      subject,
      html,
      attachments: [
        {
          filename,
          // Prepend a UTF-8 BOM so Excel (FR) renders accented values correctly.
          content: Buffer.from(`﻿${csv}`, "utf-8"),
          contentType: "text/csv; charset=utf-8",
        },
      ],
    });

    logger.info("Order export sent", { recipient, lines: lineCount, messageId: info.messageId });

    return res.status(200).json({
      success: true,
      sent: true,
      lines: lineCount,
      cableLines,
      messageId: info.messageId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    logger.error("Order export failed", { error: message });

    return res.status(500).json({ error: message });
  }
};

export default handler;
