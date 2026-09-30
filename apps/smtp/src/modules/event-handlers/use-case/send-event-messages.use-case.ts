import { err, errAsync, Result, ResultAsync } from "neverthrow";

import { BaseError } from "../../../errors";
import { bytesToKb } from "../../../lib/bytes-to-kb";
import { createLogger } from "../../../logger";
import { applyIbanGuard } from "../../iban-guard/iban-guard";
import { SmtpConfiguration } from "../../smtp/configuration/smtp-config-schema";
import { IGetSmtpConfiguration } from "../../smtp/configuration/smtp-configuration.service";
import { IEmailCompiler } from "../../smtp/services/email-compiler";
import { ISMTPEmailSender, SendMailArgs } from "../../smtp/services/smtp-email-sender";
import { MessageEventTypes } from "../message-event-types";

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class SendEventMessagesUseCase {
  static BaseError = BaseError.subclass("SendEventMessagesUseCaseError");

  /**
   * Errors thrown when something goes wrong and Saleor should retry
   */
  static ServerError = BaseError.subclass("SendEventMessagesUseCaseServerError");

  static FailedToFetchConfigurationError = this.ServerError.subclass(
    "FailedToFetchConfigurationError",
  );

  /**
   * Errors related to broken configuration
   */
  static ClientError = BaseError.subclass("SendEventMessagesUseCaseClientError");

  static MissingAvailableConfigurationError = this.ClientError.subclass(
    "MissingAvailableConfigurationError",
  );

  static EmailCompilationError = this.ClientError.subclass("EmailCompilationError");

  static InvalidSenderConfigError = this.ClientError.subclass("InvalidSenderConfigError");

  /**
   * Errors that externally can be translated to no-op operations due to design of the app.
   * In some cases app should just ignore the event, e.g. when it's disabled.
   */
  static NoOpError = BaseError.subclass("SendEventMessagesUseCaseNoOpError");

  static EventConfigNotActiveError = this.NoOpError.subclass("EventConfigNotActiveError");

  static EventSettingsMissingError = this.NoOpError.subclass("EventSettingsMissingError");

  /**
   * A no-op on purpose: the guard has already logged and alerted, and a retry from
   * Saleor would only produce the same email, blocked again, with another alert.
   */
  static IbanGuardBlockedError = this.NoOpError.subclass("IbanGuardBlockedError");

  private logger = createLogger("SendEventMessagesUseCase");

  constructor(
    private deps: {
      smtpConfigurationService: IGetSmtpConfiguration;
      emailCompiler: IEmailCompiler;
      emailSender: ISMTPEmailSender;
      /** Injected in tests; defaults to the real guard. */
      ibanGuard?: typeof applyIbanGuard;
    },
  ) {}

  private processSingleConfiguration({
    config,
    event,
    payload,
    recipientEmail,
    channelSlug,
  }: {
    config: SmtpConfiguration;
    event: MessageEventTypes;
    payload: unknown;
    recipientEmail: string;
    channelSlug: string;
  }) {
    const eventSettings = config.events.find((e) => e.eventType === event);

    if (!eventSettings) {
      this.logger.info("Configuration found but settings for this event are missing");

      return errAsync(
        new SendEventMessagesUseCase.EventSettingsMissingError(
          "Settings not found for this event",
          {
            props: {
              event,
            },
          },
        ),
      );
    }

    if (!eventSettings.active) {
      this.logger.info("Configuration found, but setting for this event are not active");

      return errAsync(
        new SendEventMessagesUseCase.EventConfigNotActiveError("Event config is disabled", {
          props: {
            event: eventSettings.eventType,
          },
        }),
      );
    }

    if (!config.senderName || !config.senderEmail) {
      this.logger.warn("Configuration is invalid: missing sender data", {
        senderName: config.senderName,
        senderEmail: config.senderEmail,
      });

      return errAsync(
        new SendEventMessagesUseCase.InvalidSenderConfigError("Missing sender name or email", {
          props: {
            senderName: config.senderName,
            senderEmail: config.senderEmail,
          },
        }),
      );
    }

    const preparedEmailResult = this.deps.emailCompiler.compile({
      event: event,
      payload: payload,
      recipientEmail: recipientEmail,
      bodyTemplate: eventSettings.template,
      subjectTemplate: eventSettings.subject,
      senderEmail: config.senderEmail,
      senderName: config.senderName,
    });

    if (preparedEmailResult.isErr()) {
      this.logger.warn("Failed to compile email template");

      return errAsync(
        new SendEventMessagesUseCase.EmailCompilationError("Failed to compile error", {
          errors: [preparedEmailResult.error],
          props: {
            channelSlug,
            event,
          },
        }),
      );
    }

    this.logger.info("Successfully compiled email template", {
      bodyTemplateSizeKb: bytesToKb(new Blob([eventSettings.template]).size),
      subjectTemplateSizeKb: bytesToKb(new Blob([eventSettings.subject]).size),
    });

    const smtpSettings: SendMailArgs["smtpSettings"] = {
      host: config.smtpHost,
      port: parseInt(config.smtpPort, 10),
      encryption: config.encryption,
    };

    if (config.smtpUser) {
      this.logger.debug("Detected SMTP user config. Applying to configuration.");

      smtpSettings.auth = {
        user: config.smtpUser,
        pass: config.smtpPassword,
      };
    }

    const mailData = preparedEmailResult.value;

    /*
     * Templates are editable from the Dashboard and payload fields come from customers,
     * so a compiled email can carry an IBAN nobody meant to send.
     */
    const ibanGuard = this.deps.ibanGuard ?? applyIbanGuard;

    return ResultAsync.fromSafePromise(
      ibanGuard({
        email: mailData,
        source: `event:${event}`,
        sendAlert: (alert) =>
          this.deps.emailSender.sendEmailWithSmtp({
            smtpSettings,
            mailData: {
              from: mailData.from,
              to: alert.to,
              subject: alert.subject,
              text: alert.text,
              html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(
                alert.text,
              )}</pre>`,
            },
          }),
      }),
    ).andThen((verdict) => {
      if (verdict.blocked) {
        return errAsync(
          new SendEventMessagesUseCase.IbanGuardBlockedError(
            "Email not sent: it contains an IBAN that is not on the allowlist",
            { props: { event, channelSlug } },
          ),
        );
      }

      return this.sendCompiledEmail(mailData, smtpSettings);
    });
  }

  private sendCompiledEmail(
    mailData: SendMailArgs["mailData"],
    smtpSettings: SendMailArgs["smtpSettings"],
  ) {
    return ResultAsync.fromPromise(
      this.deps.emailSender.sendEmailWithSmtp({
        mailData,
        smtpSettings,
      }),
      (err) => {
        this.logger.debug("Error sending email with SMTP", { error: err });

        if (typeof err === "object" && err && "responseCode" in err) {
          /**
           * Wrong configuration, server config, ssl etc
           * https://stackoverflow.com/questions/221416/smtp-error-554-message-does-not-conform-to-standards
           */
          if (err.responseCode === 554) {
            return new SendEventMessagesUseCase.ClientError("Failed to send email via SMTP - 554", {
              cause: err,
            });
          }
        }

        return new SendEventMessagesUseCase.ServerError("Failed to send email via SMTP", {
          cause: err,
        });
      },
    );
  }

  async sendEventMessages({
    event,
    payload,
    recipientEmail,
    channelSlug,
  }: {
    channelSlug: string;
    payload: unknown;
    recipientEmail: string;
    event: MessageEventTypes;
  }): Promise<Result<unknown, Array<InstanceType<typeof SendEventMessagesUseCase.BaseError>>>> {
    this.logger.info("Calling sendEventMessages", { channelSlug, event });

    const availableSmtpConfigurations = await this.deps.smtpConfigurationService.getConfigurations({
      active: true,
      availableInChannel: channelSlug,
    });

    if (availableSmtpConfigurations.isErr()) {
      this.logger.warn("Failed to fetch configuration");

      return err([
        new SendEventMessagesUseCase.FailedToFetchConfigurationError(
          "Failed to fetch configuration",
          {
            errors: [availableSmtpConfigurations.error],
            props: {
              channelSlug,
              event,
            },
          },
        ),
      ]);
    }

    if (availableSmtpConfigurations.value.length === 0) {
      this.logger.warn("Configuration list is empty, app is not configured");

      return err([
        new SendEventMessagesUseCase.MissingAvailableConfigurationError(
          "Missing configuration for this channel that is active",
          {
            errors: [],
            props: {
              channelSlug,
              event,
            },
          },
        ),
      ]);
    }

    this.logger.info(
      `Detected valid configuration (${availableSmtpConfigurations.value.length}). Will process to send emails`,
    );

    const processingResults = await Promise.all(
      availableSmtpConfigurations.value.map((config) =>
        this.processSingleConfiguration({
          config,
          event,
          payload,
          recipientEmail,
          channelSlug,
        }),
      ),
    );

    return Result.combineWithAllErrors(processingResults);
  }
}
