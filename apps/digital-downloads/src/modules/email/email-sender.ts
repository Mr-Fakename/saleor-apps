import { err, ok, Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { env } from "@/lib/env";

const logger = createLogger("EmailSender");

export const EmailSenderErrors = {
  SendEmailError: BaseError.subclass("SendEmailError", {
    props: {
      _brand: "EmailSender.SendEmailError" as const,
    },
  }),
  ConfigurationError: BaseError.subclass("ConfigurationError", {
    props: {
      _brand: "EmailSender.ConfigurationError" as const,
    },
  }),
};

export type EmailSenderError =
  | InstanceType<typeof EmailSenderErrors.SendEmailError>
  | InstanceType<typeof EmailSenderErrors.ConfigurationError>;

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export class EmailSender {
  async sendEmail(input: SendEmailInput): Promise<Result<void, EmailSenderError>> {
    try {
      if (!env.EMAIL_ENABLED) {
        logger.debug("Email sending is disabled via EMAIL_ENABLED=false");

        return ok(undefined);
      }

      const smtpAppUrl = env.SMTP_APP_URL;
      const smtpAppApiKey = env.SMTP_APP_API_KEY;

      if (!smtpAppUrl || !smtpAppApiKey) {
        logger.debug(
          "Email sending skipped - SMTP App not configured (SMTP_APP_URL or SMTP_APP_API_KEY missing)",
        );

        return ok(undefined);
      }

      const { to, subject, html } = input;

      logger.info("Sending email via SMTP App", {
        to,
        subject,
        smtpAppUrl,
      });

      const response = await fetch(`${smtpAppUrl}/api/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": smtpAppApiKey,
        },
        body: JSON.stringify({ to, subject, html }),
      });

      if (!response.ok) {
        const body = await response.text();

        throw new Error(`SMTP App responded with ${response.status}: ${body}`);
      }

      const result = await response.json();

      logger.info("Email sent successfully via SMTP App", {
        to,
        subject,
        messageId: result.messageId,
      });

      return ok(undefined);
    } catch (error) {
      logger.error("Failed to send email", {
        error,
        to: input.to,
        subject: input.subject,
      });

      return err(
        new EmailSenderErrors.SendEmailError("Failed to send email", {
          cause: error,
        }),
      );
    }
  }
}

export const emailSender = new EmailSender();
