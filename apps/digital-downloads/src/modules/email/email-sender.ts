import nodemailer from "nodemailer";
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
  private transporter: nodemailer.Transporter | null = null;
  private initialized = false;

  private initializeTransporter() {
    // Only initialize once
    if (this.initialized) {
      return;
    }

    this.initialized = true;

    try {
      // Check if email is enabled
      if (!env.EMAIL_ENABLED) {
        logger.info("Email sending is disabled via EMAIL_ENABLED=false");
        return;
      }

      // Validate required configuration
      if (!env.EMAIL_FROM) {
        throw new EmailSenderErrors.ConfigurationError(
          "EMAIL_FROM is required when EMAIL_ENABLED=true",
        );
      }

      // Use SMTP if configured, otherwise use SendGrid
      if (env.SMTP_HOST) {
        logger.info("Initializing SMTP email sender", {
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          from: env.EMAIL_FROM,
        });

        this.transporter = nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_PORT === 465, // true for 465, false for other ports
          auth: env.SMTP_USER
            ? {
                user: env.SMTP_USER,
                pass: env.SMTP_PASSWORD,
              }
            : undefined,
        });
      } else if (env.SENDGRID_API_KEY) {
        logger.info("Initializing SendGrid email sender", {
          from: env.EMAIL_FROM,
        });

        // SendGrid SMTP configuration
        this.transporter = nodemailer.createTransport({
          host: "smtp.sendgrid.net",
          port: 587,
          secure: false,
          auth: {
            user: "apikey",
            pass: env.SENDGRID_API_KEY,
          },
        });
      } else {
        logger.warn("No email provider configured (neither SMTP nor SendGrid)");
      }
    } catch (error) {
      logger.error("Failed to initialize email transporter", { error });
      throw error;
    }
  }

  async sendEmail(input: SendEmailInput): Promise<Result<void, EmailSenderError>> {
    try {
      // Lazy initialization - only initialize when actually sending an email
      this.initializeTransporter();

      if (!this.transporter) {
        logger.debug(
          "Email sending skipped - transporter not initialized (disabled or not configured)",
        );
        return ok(undefined);
      }

      const { to, subject, html, text } = input;

      logger.info("Sending email", {
        to,
        subject,
        from: env.EMAIL_FROM,
      });

      await this.transporter.sendMail({
        from: env.EMAIL_FROM,
        to,
        subject,
        html,
        text: text || this.stripHtml(html),
      });

      logger.info("Email sent successfully", {
        to,
        subject,
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

  private stripHtml(html: string): string {
    // Simple HTML stripping for text version
    return html
      .replace(/<style[^>]*>.*?<\/style>/gi, "")
      .replace(/<script[^>]*>.*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
}

export const emailSender = new EmailSender();
