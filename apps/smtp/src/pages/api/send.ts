import { verifyJWT } from "@saleor/app-sdk/auth";
import {
  SALEOR_API_URL_HEADER,
  SALEOR_AUTHORIZATION_BEARER_HEADER,
} from "@saleor/app-sdk/headers";
import { convert } from "html-to-text";
import { NextApiHandler } from "next";
import nodemailer from "nodemailer";

import { createLogger } from "../../logger";
import { saleorApp } from "../../saleor-app";

const logger = createLogger("api/send");

function setCorsHeaders(res: import("next").NextApiResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, saleor-api-url, saleor-authorization-bearer");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/**
 * Authenticate the request using one of two methods:
 *
 * 1. API Key: `X-API-Key` header matching `EMAIL_BRIDGE_API_SECRET` env var
 *    → Used by Dashboard and internal services for simple pre-rendered email sending
 *
 * 2. Saleor JWT: `saleor-authorization-bearer` + `saleor-api-url` headers
 *    → Used by other Saleor apps (e.g. Digital Downloads) with platform-level auth
 *    → Verifies the JWT against the registered Saleor instance via APL
 *
 * Returns null on success, or a string error message on failure.
 */
async function authenticateRequest(
  headers: Record<string, string | string[] | undefined>,
): Promise<string | null> {
  // Method 1: API Key authentication
  const apiKey = headers["x-api-key"];
  const apiSecret = process.env.EMAIL_BRIDGE_API_SECRET;

  if (apiKey && apiSecret && apiKey === apiSecret) {
    return null; // authenticated
  }

  // Method 2: Saleor JWT authentication
  const token = headers[SALEOR_AUTHORIZATION_BEARER_HEADER] as string | undefined;
  const saleorApiUrl = headers[SALEOR_API_URL_HEADER] as string | undefined;

  if (token && saleorApiUrl) {
    try {
      const authData = await saleorApp.apl.get(saleorApiUrl);

      if (!authData) {
        logger.debug("JWT auth failed: no auth data found for Saleor API URL");

        return "Unauthorized";
      }

      await verifyJWT({
        appId: authData.appId,
        token,
        saleorApiUrl,
      });

      return null; // authenticated
    } catch (_error) {
      logger.debug("JWT verification failed");

      return "Unauthorized";
    }
  }

  // Neither method provided valid credentials
  if (!apiSecret) {
    return "Email bridge not configured";
  }

  return "Unauthorized";
}

/**
 * REST endpoint for sending pre-rendered emails via the SMTP App's configured transporter.
 * This replaces the standalone email-bridge service.
 *
 * Authentication (dual):
 *   - API Key: `X-API-Key` header matching EMAIL_BRIDGE_API_SECRET env var
 *   - Saleor JWT: `saleor-authorization-bearer` + `saleor-api-url` headers
 *
 * GET  /api/send → Health check { status: "ok" }
 * POST /api/send → Send email
 *   Body: { to: string, subject: string, html: string }
 *   Response: { success: true, messageId: string } or { error: string }
 */
const handler: NextApiHandler = async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method === "GET") {
    return res.status(200).json({ status: "ok" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authError = await authenticateRequest(req.headers);

  if (authError) {
    const statusCode = authError === "Email bridge not configured" ? 500 : 401;

    return res.status(statusCode).json({ error: authError });
  }

  const { to, subject, html } = req.body;

  if (!to || !subject || !html) {
    return res.status(400).json({ error: "Missing required fields: to, subject, html" });
  }

  // Use SMTP settings from environment (same as email-bridge pattern)
  const smtpHost = process.env.EMAIL_BRIDGE_SMTP_HOST;
  const smtpPort = parseInt(process.env.EMAIL_BRIDGE_SMTP_PORT || "587", 10);
  const smtpSecure = process.env.EMAIL_BRIDGE_SMTP_SECURE === "true";
  const smtpUser = process.env.EMAIL_BRIDGE_SMTP_USER;
  const smtpPass = process.env.EMAIL_BRIDGE_SMTP_PASS;
  const smtpFrom = process.env.EMAIL_BRIDGE_SMTP_FROM;

  if (!smtpHost) {
    logger.error("EMAIL_BRIDGE_SMTP_HOST is not configured");

    return res.status(500).json({ error: "SMTP not configured" });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      // On the submission port (587, secure=false) force STARTTLS so credentials and
      // content are never sent in cleartext, and require TLS 1.2+ — Orange/Free reject
      // older TLS (RFC 8996). When secure=true (465) the connection is already implicit TLS.
      requireTLS: !smtpSecure,
      tls: { minVersion: "TLSv1.2" },
      auth: smtpUser
        ? {
            user: smtpUser,
            pass: smtpPass,
          }
        : undefined,
    });

    // Always send a proper multipart/alternative message: a text/plain part alongside the
    // HTML. HTML-only mail is a spam-filter signal (notably at French ISPs via Vade). If the
    // HTML can't be converted, fall back to HTML-only rather than failing the send.
    let text: string | undefined;

    try {
      text = convert(html);
    } catch {
      text = undefined;
    }

    const info = await transporter.sendMail({
      from: smtpFrom,
      to,
      subject,
      html,
      text,
    });

    logger.info("Email sent via bridge endpoint", {
      recipientEmail: to,
      emailSubject: subject,
      messageId: info.messageId,
    });

    return res.status(200).json({ success: true, messageId: info.messageId });
  } catch (error) {
    logger.error("Failed to send email via bridge endpoint", {
      error: error instanceof Error ? error.message : "Unknown error",
    });

    const message = error instanceof Error ? error.message : "Unknown error";

    return res.status(500).json({ error: message });
  }
};

export default handler;
