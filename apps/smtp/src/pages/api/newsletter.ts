import crypto from "crypto";
import { NextApiHandler } from "next";
import nodemailer from "nodemailer";

import { createLogger } from "../../logger";
import { saleorApp } from "../../saleor-app";

const logger = createLogger("api/newsletter");

const METADATA_KEY = "newsletter_subscribers";

interface Subscriber {
  email: string;
  locale: string;
  status: "pending" | "confirmed";
  token: string;
  subscribedAt: string;
  confirmedAt?: string;
}

interface AuthData {
  token: string;
  saleorApiUrl: string;
  appId: string;
}

function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function authenticateApiKey(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const apiKey = headers["x-api-key"];
  const apiSecret = process.env.EMAIL_BRIDGE_API_SECRET;

  return !!(apiKey && apiSecret && apiKey === apiSecret);
}

/**
 * Read the app's global ID and newsletter subscribers from Saleor private metadata.
 */
async function getAppIdAndSubscribers(
  authData: AuthData,
): Promise<{ appGlobalId: string | null; subscribers: Subscriber[] }> {
  try {
    const query = `query { app { id privateMetadata { key value } } }`;
    const response = await fetch(authData.saleorApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authData.token}`,
      },
      body: JSON.stringify({ query }),
    });
    const data = await response.json();
    const app = data?.data?.app;

    if (!app) return { appGlobalId: null, subscribers: [] };

    const metadata: Array<{ key: string; value: string }> = app.privateMetadata || [];
    const entry = metadata.find((m) => m.key === METADATA_KEY);

    return {
      appGlobalId: app.id,
      subscribers: entry ? JSON.parse(entry.value) : [],
    };
  } catch (error) {
    logger.error("Failed to read subscribers from metadata", { error });

    return { appGlobalId: null, subscribers: [] };
  }
}

/**
 * Persist the subscriber list to Saleor app private metadata.
 */
async function saveSubscribers(
  authData: AuthData,
  appGlobalId: string,
  subscribers: Subscriber[],
): Promise<boolean> {
  try {
    const mutation = `
      mutation UpdatePrivateMetadata($id: ID!, $input: [MetadataInput!]!) {
        updatePrivateMetadata(id: $id, input: $input) {
          errors { field message }
        }
      }
    `;
    const response = await fetch(authData.saleorApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authData.token}`,
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          id: appGlobalId,
          input: [{ key: METADATA_KEY, value: JSON.stringify(subscribers) }],
        },
      }),
    });
    const data = await response.json();

    if (data?.data?.updatePrivateMetadata?.errors?.length) {
      logger.error("Metadata mutation errors", {
        errors: data.data.updatePrivateMetadata.errors,
      });

      return false;
    }

    return true;
  } catch (error) {
    logger.error("Failed to save subscribers to metadata", { error });

    return false;
  }
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.EMAIL_BRIDGE_SMTP_HOST,
    port: parseInt(process.env.EMAIL_BRIDGE_SMTP_PORT || "587", 10),
    secure: process.env.EMAIL_BRIDGE_SMTP_SECURE === "true",
    auth: process.env.EMAIL_BRIDGE_SMTP_USER
      ? {
          user: process.env.EMAIL_BRIDGE_SMTP_USER,
          pass: process.env.EMAIL_BRIDGE_SMTP_PASS,
        }
      : undefined,
  });
}

function generateConfirmationEmailHtml(
  confirmUrl: string,
  unsubscribeUrl: string,
  locale: string,
  brandName: string,
): string {
  const copy: Record<
    string,
    { heading: string; body: string; cta: string; footer: string; unsub: string }
  > = {
    fr: {
      heading: "Confirmez votre inscription",
      body: `Merci de votre intérêt pour ${brandName}\u00a0! Cliquez sur le bouton ci-dessous pour confirmer votre inscription à notre newsletter et être informé de nos actualités, nouveaux produits et offres B-stock.`,
      cta: "Confirmer mon inscription",
      footer: "Si vous n'avez pas demandé cette inscription, vous pouvez ignorer cet e-mail.",
      unsub: "Se désabonner",
    },
    en: {
      heading: "Confirm your subscription",
      body: `Thank you for your interest in ${brandName}! Click the button below to confirm your newsletter subscription and stay informed about our latest news, new products, and B-stock deals.`,
      cta: "Confirm my subscription",
      footer: "If you didn't request this subscription, you can ignore this email.",
      unsub: "Unsubscribe",
    },
    es: {
      heading: "Confirma tu suscripción",
      body: `¡Gracias por tu interés en ${brandName}! Haz clic en el botón de abajo para confirmar tu suscripción al boletín y mantenerte informado sobre novedades, nuevos productos y ofertas B-stock.`,
      cta: "Confirmar mi suscripción",
      footer: "Si no solicitaste esta suscripción, puedes ignorar este correo.",
      unsub: "Desuscribirse",
    },
  };

  const c = copy[locale] || copy.fr;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr><td style="height:4px;background:linear-gradient(90deg,#003db0,#e2cc8a);"></td></tr>
        <tr><td style="padding:40px 32px;">
          <h1 style="margin:0 0 16px;font-size:24px;font-weight:600;color:#1c1917;letter-spacing:-0.02em;">${c.heading}</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#57534e;">${c.body}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr><td style="border-radius:8px;background:#003db0;">
              <a href="${confirmUrl}" style="display:inline-block;padding:14px 32px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.02em;">${c.cta}</a>
            </td></tr>
          </table>
          <p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#a8a29e;text-align:center;">${c.footer}</p>
          <p style="margin:12px 0 0;font-size:11px;color:#d6d3d1;text-align:center;">
            <a href="${unsubscribeUrl}" style="color:#a8a29e;text-decoration:underline;">${c.unsub}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendConfirmationEmail(
  email: string,
  token: string,
  locale: string,
): Promise<void> {
  const storefrontUrl = process.env.STOREFRONT_URL || "http://localhost:3000";
  const brandName = process.env.BRAND_NAME || "Our Store";

  const confirmUrl = `${storefrontUrl}/api/newsletter/confirm?token=${token}&email=${encodeURIComponent(email)}&locale=${locale}`;
  const unsubscribeUrl = `${storefrontUrl}/api/newsletter/unsubscribe?token=${token}&email=${encodeURIComponent(email)}&locale=${locale}`;

  const subjects: Record<string, string> = {
    fr: "Confirmez votre inscription à la newsletter",
    en: "Confirm your newsletter subscription",
    es: "Confirma tu suscripción al boletín",
  };

  const transporter = createTransporter();

  await transporter.sendMail({
    from: process.env.EMAIL_BRIDGE_SMTP_FROM,
    to: email,
    subject: subjects[locale] || subjects.fr,
    html: generateConfirmationEmailHtml(confirmUrl, unsubscribeUrl, locale, brandName),
  });

  logger.info("Newsletter confirmation email sent", { email, locale });
}

function setCorsHeaders(res: import("next").NextApiResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/**
 * Newsletter subscriber management endpoint.
 *
 * Authentication: X-API-Key header matching EMAIL_BRIDGE_API_SECRET env var.
 *
 * POST /api/newsletter
 *   Body: { action, email, locale?, token?, saleorApiUrl }
 *
 * Actions:
 *   - subscribe: Register a new subscriber and send confirmation email
 *   - confirm:   Verify double opt-in token
 *   - unsubscribe: Remove subscriber
 */
const handler: NextApiHandler = async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!authenticateApiKey(req.headers)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const {
    action,
    email,
    locale = "fr",
    token: confirmToken,
    saleorApiUrl,
  } = req.body;

  if (!saleorApiUrl) {
    return res.status(400).json({ error: "saleorApiUrl is required" });
  }

  const authData = await saleorApp.apl.get(saleorApiUrl);

  if (!authData) {
    logger.error("No auth data found for saleorApiUrl", { saleorApiUrl });

    return res.status(500).json({ error: "App not registered for this Saleor instance" });
  }

  const { appGlobalId, subscribers } = await getAppIdAndSubscribers(authData);

  if (!appGlobalId) {
    return res.status(500).json({ error: "Could not retrieve app metadata" });
  }

  switch (action) {
    case "subscribe": {
      if (!email) {
        return res.status(400).json({ error: "email_required" });
      }

      const existing = subscribers.find((s) => s.email === email);

      if (existing?.status === "confirmed") {
        return res.status(409).json({ error: "already_subscribed" });
      }

      const newToken = generateToken();

      if (existing) {
        // Re-send confirmation for pending subscriber
        existing.token = newToken;
        existing.locale = locale;
      } else {
        subscribers.push({
          email,
          locale,
          status: "pending",
          token: newToken,
          subscribedAt: new Date().toISOString(),
        });
      }

      const saved = await saveSubscribers(authData, appGlobalId, subscribers);

      if (!saved) {
        return res.status(500).json({ error: "storage_error" });
      }

      try {
        await sendConfirmationEmail(email, newToken, locale);
      } catch (error) {
        logger.error("Failed to send confirmation email", {
          error: error instanceof Error ? error.message : "Unknown",
          email,
        });

        return res.status(500).json({ error: "email_send_failed" });
      }

      return res.status(200).json({ success: true });
    }

    case "confirm": {
      if (!confirmToken || !email) {
        return res.status(400).json({ error: "token_and_email_required" });
      }

      const subscriber = subscribers.find(
        (s) => s.email === email && s.token === confirmToken,
      );

      if (!subscriber) {
        return res.status(404).json({ error: "invalid_token" });
      }

      subscriber.status = "confirmed";
      subscriber.confirmedAt = new Date().toISOString();

      const saved = await saveSubscribers(authData, appGlobalId, subscribers);

      if (!saved) {
        return res.status(500).json({ error: "storage_error" });
      }

      logger.info("Newsletter subscription confirmed", { email });

      return res.status(200).json({ success: true });
    }

    case "unsubscribe": {
      if (!confirmToken || !email) {
        return res.status(400).json({ error: "token_and_email_required" });
      }

      const index = subscribers.findIndex(
        (s) => s.email === email && s.token === confirmToken,
      );

      if (index === -1) {
        return res.status(404).json({ error: "invalid_token" });
      }

      subscribers.splice(index, 1);

      const saved = await saveSubscribers(authData, appGlobalId, subscribers);

      if (!saved) {
        return res.status(500).json({ error: "storage_error" });
      }

      logger.info("Newsletter unsubscribed", { email });

      return res.status(200).json({ success: true });
    }

    default:
      return res.status(400).json({ error: "Invalid action" });
  }
};

export default handler;
