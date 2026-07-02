import { NextApiHandler } from "next";

import { createLogger } from "../../logger";
import {
  messageEventTypes,
  MessageEventTypes,
} from "../../modules/event-handlers/message-event-types";
import { SendEventMessagesUseCase } from "../../modules/event-handlers/use-case/send-event-messages.use-case";
import { SendEventMessagesUseCaseFactory } from "../../modules/event-handlers/use-case/send-event-messages.use-case.factory";
import { saleorApp } from "../../saleor-app";

const logger = createLogger("api/send-event");

function setCorsHeaders(res: import("next").NextApiResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, saleor-api-url");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function isMessageEventType(value: unknown): value is MessageEventTypes {
  return typeof value === "string" && (messageEventTypes as readonly string[]).includes(value);
}

const useCaseFactory = new SendEventMessagesUseCaseFactory();

/**
 * REST endpoint for sending emails using an event type + payload, rendered via the
 * Dashboard-configured MJML/Handlebars template for that event. Auth is the same
 * X-API-Key used by /api/send. The storefront uses this for flows that don't originate
 * from a Saleor NOTIFY_USER webhook (e.g. EU withdrawal button).
 *
 * POST /api/send-event
 *   Headers:
 *     X-API-Key: EMAIL_BRIDGE_API_SECRET
 *     saleor-api-url: https://saleor.example.com/graphql/  (optional; falls back to the first APL entry)
 *   Body:
 *     {
 *       eventType: "WITHDRAWAL_REQUESTED_CUSTOMER" | ...,
 *       channelSlug: "default-channel",
 *       recipients: ["a@b.com"],     // or a single "recipient" field
 *       payload: { ... }             // matches the event's payload shape
 *     }
 */
const handler: NextApiHandler = async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = req.headers["x-api-key"];
  const apiSecret = process.env.EMAIL_BRIDGE_API_SECRET;

  if (!apiSecret) {
    logger.error("EMAIL_BRIDGE_API_SECRET is not configured");

    return res.status(500).json({ error: "Email bridge not configured" });
  }

  if (!apiKey || apiKey !== apiSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { eventType, channelSlug, recipient, recipients, payload } = req.body ?? {};

  if (!isMessageEventType(eventType)) {
    return res.status(400).json({ error: `Unknown eventType: ${String(eventType)}` });
  }

  if (typeof channelSlug !== "string" || !channelSlug) {
    return res.status(400).json({ error: "Missing channelSlug" });
  }

  const recipientList: string[] = Array.isArray(recipients)
    ? recipients.filter((r): r is string => typeof r === "string" && r.length > 0)
    : typeof recipient === "string" && recipient.length > 0
      ? [recipient]
      : [];

  if (recipientList.length === 0) {
    return res.status(400).json({ error: "Missing recipient(s)" });
  }

  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "Missing payload" });
  }

  const requestedSaleorApiUrl = req.headers["saleor-api-url"] as string | undefined;
  const authData = requestedSaleorApiUrl
    ? await saleorApp.apl.get(requestedSaleorApiUrl)
    : (await saleorApp.apl.getAll())[0];

  if (!authData) {
    logger.error("No APL auth data available to dispatch event", {
      requestedSaleorApiUrl,
    });

    return res.status(500).json({ error: "App is not registered with any Saleor instance" });
  }

  const useCase = useCaseFactory.createFromAuthData(authData);

  try {
    const results = await Promise.all(
      recipientList.map((recipientEmail) =>
        useCase.sendEventMessages({
          channelSlug,
          event: eventType,
          payload,
          recipientEmail,
        }),
      ),
    );

    const hasSuccess = results.some((r) => r.isOk());

    if (hasSuccess) {
      logger.info("Successfully dispatched event email(s)", {
        eventType,
        recipientCount: recipientList.length,
      });

      return res.status(200).json({ success: true, recipientCount: recipientList.length });
    }

    const firstError = results.find((r) => r.isErr());

    if (firstError && firstError.isErr()) {
      const errorInstance = firstError.error[0];

      if (errorInstance instanceof SendEventMessagesUseCase.ServerError) {
        logger.warn("Failed to send event email [server]", { error: firstError.error });

        return res.status(502).json({ error: "Failed to send email" });
      }

      if (errorInstance instanceof SendEventMessagesUseCase.ClientError) {
        logger.info("Failed to send event email [client]", { error: firstError.error });

        return res.status(400).json({ error: "Email configuration error" });
      }

      if (errorInstance instanceof SendEventMessagesUseCase.NoOpError) {
        logger.info("Event not configured, skipping", { error: firstError.error });

        return res.status(200).json({ success: false, skipped: true });
      }

      logger.error("Unhandled use case error", { error: firstError.error });

      return res.status(500).json({ error: "Unhandled error" });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    logger.error("Unhandled exception in /api/send-event", {
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return res.status(500).json({ error: "Internal error" });
  }
};

export default handler;
