import { NextJsWebhookHandler, SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next";
import { wrapWithLoggerContext } from "@saleor/apps-logger/node";
import { withSpanAttributes } from "@saleor/apps-otel/src/with-span-attributes";
import { captureException } from "@sentry/nextjs";

import { notifyEventMapping, NotifySubscriptionPayload } from "../../../lib/notify-event-types";
import { createLogger } from "../../../logger";
import { loggerContext } from "../../../logger-context";
import { SendEventMessagesUseCase } from "../../../modules/event-handlers/use-case/send-event-messages.use-case";
import { SendEventMessagesUseCaseFactory } from "../../../modules/event-handlers/use-case/send-event-messages.use-case.factory";
import { saleorApp } from "../../../saleor-app";

/*
 * The Notify webhook is triggered on multiple Saleor events.
 * Type of the message is determined by `notify_event` field in the payload.
 */

export const notifyWebhook = new SaleorAsyncWebhook<NotifySubscriptionPayload>({
  name: "notify",
  webhookPath: "api/webhooks/notify",
  event: "NOTIFY_USER",
  apl: saleorApp.apl,
  query: "{}", // We are using the default payload instead of subscription
});

const logger = createLogger(notifyWebhook.webhookPath);

const useCaseFactory = new SendEventMessagesUseCaseFactory();

const handler: NextJsWebhookHandler<NotifySubscriptionPayload> = async (req, res, context) => {
  logger.info("Webhook received");

  const { payload, authData } = context;

  const { channel_slug: channel } = payload.payload;

  /**
   * Since NOTIFY can be send on events unrelated to this app, lack of mapping means the App does not support it
   * Some events are not supported by the SMTP app, but we can still add them to the log context
   */
  const event = notifyEventMapping[payload.notify_event];

  loggerContext.set("event", event);

  if (!event) {
    loggerContext.set("event", payload.notify_event);

    logger.info(`The type of received notify event (${payload.notify_event}) is not supported.`);

    return res.status(200).json({ message: `${payload.notify_event} event is not supported.` });
  }

  // STAFF_ORDER_CONFIRMATION uses recipient_list (array) instead of recipient_email
  const recipientEmails: string[] = [];

  if (
    payload.notify_event === "staff_order_confirmation" &&
    "recipient_list" in payload.payload &&
    Array.isArray(payload.payload.recipient_list)
  ) {
    recipientEmails.push(...payload.payload.recipient_list);
  }

  if ("recipient_email" in payload.payload && payload.payload.recipient_email) {
    if (recipientEmails.length === 0) {
      recipientEmails.push(payload.payload.recipient_email);
    }
  }

  if (recipientEmails.length === 0) {
    logger.error(`The email recipient has not been specified in the event payload.`);

    return res
      .status(200)
      .json({ error: "Email recipient has not been specified in the event payload." });
  }

  const useCase = useCaseFactory.createFromAuthData(authData);

  try {
    // Send to all recipients (usually 1, but STAFF_ORDER_CONFIRMATION can have multiple)
    const results = await Promise.all(
      recipientEmails.map((recipientEmail) =>
        useCase.sendEventMessages({
          channelSlug: channel,
          event,
          payload: payload.payload,
          recipientEmail,
        }),
      ),
    );

    // Check if any result succeeded
    const hasSuccess = results.some((r) => r.isOk());
    const firstError = results.find((r) => r.isErr());

    if (hasSuccess) {
      logger.info("Successfully sent email(s)", {
        recipientCount: recipientEmails.length,
      });

      return res.status(200).json({ message: "The event has been handled" });
    }

    if (firstError && firstError.isErr()) {
      const err = firstError.error;
      const errorInstance = err[0];

      if (errorInstance instanceof SendEventMessagesUseCase.ServerError) {
        logger.warn("Failed to send email(s) [server error]", { error: err });

        return res.status(500).json({ message: "Failed to send email" });
      } else if (errorInstance instanceof SendEventMessagesUseCase.ClientError) {
        logger.info("Failed to send email(s) [client error]", { error: err });

        return res.status(400).json({ message: "Failed to send email" });
      } else if (errorInstance instanceof SendEventMessagesUseCase.NoOpError) {
        logger.info("Sending emails aborted [no op]", { error: err });

        return res.status(200).json({ message: "The event has been handled [no op]" });
      }

      logger.error("Failed to send email(s) [unhandled error]", { error: err });
      captureException(new Error("Unhandled useCase error", { cause: err }));

      return res.status(500).json({ message: "Failed to send email [unhandled]" });
    }

    return res.status(200).json({ message: "The event has been handled" });
  } catch (e) {
    logger.error("Unhandled error from useCase", {
      error: e,
    });

    captureException(e);

    return res.status(500).json({ message: "Failed to execute webhook" });
  }
};

export default wrapWithLoggerContext(
  withSpanAttributes(notifyWebhook.createHandler(handler)),
  loggerContext,
);

export const config = {
  api: {
    bodyParser: false,
  },
};
