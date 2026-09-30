import { err, errAsync, ok, okAsync } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseError } from "../../../errors";
import { resetIbanGuardAlertBudget } from "../../iban-guard/iban-guard";
import { SmtpConfiguration } from "../../smtp/configuration/smtp-config-schema";
import {
  FilterConfigurationsArgs,
  IGetSmtpConfiguration,
} from "../../smtp/configuration/smtp-configuration.service";
import { CompileArgs, IEmailCompiler } from "../../smtp/services/email-compiler";
import { ISMTPEmailSender, SendMailArgs } from "../../smtp/services/smtp-email-sender";
import { MessageEventTypes } from "../message-event-types";
import { SendEventMessagesUseCase } from "./send-event-messages.use-case";
import { SendEventMessagesUseCaseFactory } from "./send-event-messages.use-case.factory";

const EVENT_TYPE = "ACCOUNT_DELETE" satisfies MessageEventTypes;

class MockEmailCompiler implements IEmailCompiler {
  static returnSuccessCompiledEmail: IEmailCompiler["compile"] = () =>
    ok({
      text: "html text",
      from: "email from",
      subject: "email subject",
      html: "<html>html text</html>",
      to: "email to",
    });

  static returnErrorCompiling: IEmailCompiler["compile"] = () => {
    return err(new BaseError("Error compiling"));
  };

  mockEmailCompileMethod = vi.fn<(args: CompileArgs) => ReturnType<IEmailCompiler["compile"]>>();

  compile = this.mockEmailCompileMethod;
}

class MockSmtpSender implements ISMTPEmailSender {
  static returnEmptyResponse: ISMTPEmailSender["sendEmailWithSmtp"] = async () => {
    return { response: {} };
  };

  static throwInvalidResponse: ISMTPEmailSender["sendEmailWithSmtp"] = async () => {
    throw new BaseError("Some error");
  };

  mockSendEmailMethod =
    vi.fn<(args: SendMailArgs) => ReturnType<ISMTPEmailSender["sendEmailWithSmtp"]>>();

  sendEmailWithSmtp = this.mockSendEmailMethod;
}

class MockSmptConfigurationService implements IGetSmtpConfiguration {
  static getSimpleConfigurationValue = (): SmtpConfiguration => {
    return {
      id: "1",
      active: true,
      senderEmail: "sender@email.com",
      senderName: "Sender Name",
      events: [
        {
          active: true,
          eventType: EVENT_TYPE,
          subject: "Subject",
          template: "html text",
        },
      ],
      channels: { channels: ["default-channel"], mode: "exclude", override: false },
      encryption: "SSL",
      name: "Config 1",
      smtpHost: "localhost",
      smtpPassword: "admin1234",
      smtpPort: "2137",
      smtpUser: "admin",
    };
  };

  static returnValidSingleConfiguration: IGetSmtpConfiguration["getConfigurations"] = () => {
    return okAsync([MockSmptConfigurationService.getSimpleConfigurationValue()]);
  };

  static returnEmptyConfigurationsList: IGetSmtpConfiguration["getConfigurations"] = () => {
    return okAsync([]);
  };

  static returnErrorFetchingConfigurations: IGetSmtpConfiguration["getConfigurations"] = () => {
    return errAsync(new BaseError("Mock fail to fetch"));
  };

  static returnValidTwoConfigurations: IGetSmtpConfiguration["getConfigurations"] = () => {
    const c1 = this.getSimpleConfigurationValue();
    const c2 = this.getSimpleConfigurationValue();

    c2.id = "2";

    return okAsync([c1, c2]);
  };

  mockGetConfigurationsMethod =
    vi.fn<
      (args?: FilterConfigurationsArgs) => ReturnType<IGetSmtpConfiguration["getConfigurations"]>
    >();

  getConfigurations = this.mockGetConfigurationsMethod;
}

describe("SendEventMessagesUseCase", () => {
  let emailCompiler: MockEmailCompiler;
  let emailSender: MockSmtpSender;
  let smtpConfigurationService: MockSmptConfigurationService;

  let useCaseInstance: SendEventMessagesUseCase;

  beforeEach(() => {
    /**
     * Just in case reset mocks if some reference is preserved
     */
    vi.resetAllMocks();

    /**
     * Create direct dependencies
     */
    emailCompiler = new MockEmailCompiler();
    emailSender = new MockSmtpSender();
    smtpConfigurationService = new MockSmptConfigurationService();

    /**
     * Apply default return values, which can be partially overwritten in tests
     */
    emailCompiler.mockEmailCompileMethod.mockImplementation(
      MockEmailCompiler.returnSuccessCompiledEmail,
    );
    emailSender.mockSendEmailMethod.mockImplementation(MockSmtpSender.returnEmptyResponse);
    smtpConfigurationService.mockGetConfigurationsMethod.mockImplementation(
      MockSmptConfigurationService.returnValidSingleConfiguration,
    );

    /**
     * Create service instance for testing
     */
    useCaseInstance = new SendEventMessagesUseCase({
      emailCompiler,
      emailSender,
      smtpConfigurationService,
    });
  });

  describe("Factory", () => {
    it("Build with default dependencies from AuthData", () => {
      const instance = new SendEventMessagesUseCaseFactory().createFromAuthData({
        saleorApiUrl: "https://demo.saleor.cloud/graphql/",
        token: "foo",
        appId: "1",
      });

      expect(instance).toBeDefined();
    });
  });

  describe("sendEventMessages method", () => {
    it("Returns error if configurations list is empty", async () => {
      smtpConfigurationService.mockGetConfigurationsMethod.mockImplementation(
        MockSmptConfigurationService.returnEmptyConfigurationsList,
      );

      const result = await useCaseInstance.sendEventMessages({
        event: EVENT_TYPE,
        payload: {},
        channelSlug: "channel-slug",
        recipientEmail: "recipient@test.com",
      });

      expect(result?._unsafeUnwrapErr()[0]).toBeInstanceOf(
        SendEventMessagesUseCase.MissingAvailableConfigurationError,
      );
    });

    it("Returns error if failed to fetch configurations", async () => {
      smtpConfigurationService.mockGetConfigurationsMethod.mockImplementation(
        MockSmptConfigurationService.returnErrorFetchingConfigurations,
      );

      const result = await useCaseInstance.sendEventMessages({
        event: EVENT_TYPE,
        payload: {},
        channelSlug: "channel-slug",
        recipientEmail: "recipient@test.com",
      });

      expect(result?._unsafeUnwrapErr()[0]).toBeInstanceOf(
        SendEventMessagesUseCase.FailedToFetchConfigurationError,
      );

      /**
       * Additionally check if outer error contains inner error cause
       */
      expect(result?._unsafeUnwrapErr()[0].errors).toStrictEqual(
        expect.arrayContaining([expect.any(BaseError)]),
      );
    });

    describe("Multiple configurations assigned for the same event", () => {
      it("Calls SMTP service to send email for each configuration", async () => {
        smtpConfigurationService.mockGetConfigurationsMethod.mockImplementation(
          MockSmptConfigurationService.returnValidTwoConfigurations,
        );

        await useCaseInstance.sendEventMessages({
          event: EVENT_TYPE,
          payload: {},
          channelSlug: "channel-slug",
          recipientEmail: "recipient@test.com",
        });

        expect(emailSender.mockSendEmailMethod).toHaveBeenCalledTimes(2);
      });

      it("Returns error if at least one configuration fails, even if second one works", async () => {
        smtpConfigurationService.mockGetConfigurationsMethod.mockImplementation(
          MockSmptConfigurationService.returnValidTwoConfigurations,
        );

        emailSender.mockSendEmailMethod.mockImplementationOnce(MockSmtpSender.returnEmptyResponse);

        emailSender.mockSendEmailMethod.mockImplementationOnce(MockSmtpSender.throwInvalidResponse);

        const result = await useCaseInstance.sendEventMessages({
          event: EVENT_TYPE,
          payload: {},
          channelSlug: "channel-slug",
          recipientEmail: "email@example.com",
        });

        expect(result.isErr()).toBe(true);

        const errors = result._unsafeUnwrapErr();

        expect(errors[0]).toBeInstanceOf(SendEventMessagesUseCase.ServerError);
      });
    });

    describe("Single configuration assigned for the event", () => {
      it("Returns error if event is set to not active", async () => {
        const smtpConfig = MockSmptConfigurationService.getSimpleConfigurationValue();

        smtpConfig.events[0].active = false;

        smtpConfigurationService.mockGetConfigurationsMethod.mockReturnValue(okAsync([smtpConfig]));

        const result = await useCaseInstance.sendEventMessages({
          event: EVENT_TYPE,
          payload: {},
          channelSlug: "channel-slug",
          recipientEmail: "recipient@test.com",
        });

        expect(result?.isErr()).toBe(true);
        expect(result?._unsafeUnwrapErr()[0]).toBeInstanceOf(
          SendEventMessagesUseCase.EventConfigNotActiveError,
        );
      });

      it.each(["senderName", "senderEmail"] as const)(
        "Returns error if configuration '%s' is missing in configuration",
        async (field) => {
          const smtpConfig = MockSmptConfigurationService.getSimpleConfigurationValue();

          smtpConfig[field] = undefined;

          smtpConfigurationService.mockGetConfigurationsMethod.mockReturnValue(
            okAsync([smtpConfig]),
          );

          const result = await useCaseInstance.sendEventMessages({
            event: EVENT_TYPE,
            payload: {},
            channelSlug: "channel-slug",
            recipientEmail: "recipient@test.com",
          });

          expect(result?.isErr()).toBe(true);
          expect(result?._unsafeUnwrapErr()[0]).toBeInstanceOf(
            SendEventMessagesUseCase.InvalidSenderConfigError,
          );
        },
      );

      it("Returns error if email compilation fails", async () => {
        emailCompiler.mockEmailCompileMethod.mockImplementation(
          MockEmailCompiler.returnErrorCompiling,
        );

        const result = await useCaseInstance.sendEventMessages({
          event: EVENT_TYPE,
          payload: {},
          channelSlug: "channel-slug",
          recipientEmail: "recipient@test.com",
        });

        expect(result?.isErr()).toBe(true);
        expect(result?._unsafeUnwrapErr()[0]).toBeInstanceOf(
          SendEventMessagesUseCase.EmailCompilationError,
        );
      });

      it("Calls SMTP service to send email", async () => {
        await useCaseInstance.sendEventMessages({
          event: EVENT_TYPE,
          payload: {},
          channelSlug: "channel-slug",
          recipientEmail: "recipient@test.com",
        });

        expect(emailSender.mockSendEmailMethod).toHaveBeenCalledOnce();
      });

      describe("IBAN guard", () => {
        const FOREIGN_IBAN = "DE89 3704 0044 0532 0130 00";

        afterEach(() => {
          vi.unstubAllEnvs();
        });

        it("Passes the compiled email to the guard and sends it when not blocked", async () => {
          const ibanGuard = vi.fn(async () => ({ blocked: false, unknownIbans: [] }));

          useCaseInstance = new SendEventMessagesUseCase({
            emailCompiler,
            emailSender,
            smtpConfigurationService,
            ibanGuard,
          });

          const result = await useCaseInstance.sendEventMessages({
            event: EVENT_TYPE,
            payload: {},
            channelSlug: "channel-slug",
            recipientEmail: "recipient@test.com",
          });

          expect(result.isOk()).toBe(true);
          expect(ibanGuard).toHaveBeenCalledWith(
            expect.objectContaining({
              email: expect.objectContaining({ html: "<html>html text</html>" }),
              source: `event:${EVENT_TYPE}`,
            }),
          );
          expect(emailSender.mockSendEmailMethod).toHaveBeenCalledOnce();
        });

        it("Does not send and returns a no-op error when the guard blocks", async () => {
          useCaseInstance = new SendEventMessagesUseCase({
            emailCompiler,
            emailSender,
            smtpConfigurationService,
            ibanGuard: async () => ({ blocked: true, unknownIbans: ["DE89370400440532013000"] }),
          });

          const result = await useCaseInstance.sendEventMessages({
            event: EVENT_TYPE,
            payload: {},
            channelSlug: "channel-slug",
            recipientEmail: "recipient@test.com",
          });

          expect(result._unsafeUnwrapErr()[0]).toBeInstanceOf(
            SendEventMessagesUseCase.IbanGuardBlockedError,
          );
          expect(result._unsafeUnwrapErr()[0]).toBeInstanceOf(SendEventMessagesUseCase.NoOpError);
          expect(emailSender.mockSendEmailMethod).not.toHaveBeenCalled();
        });

        it("With the real guard in enforce mode, sends only the alert, through the same SMTP settings", async () => {
          vi.stubEnv("IBAN_GUARD_MODE", "enforce");
          vi.stubEnv("IBAN_GUARD_ALERT_TO", "owner@shop.test");
          resetIbanGuardAlertBudget();

          emailCompiler.mockEmailCompileMethod.mockReturnValue(
            ok({
              text: `Pay to ${FOREIGN_IBAN}`,
              from: "Shop <shop@shop.test>",
              subject: "Your order",
              html: `<p>New bank details: ${FOREIGN_IBAN}</p>`,
              to: "recipient@test.com",
            }),
          );

          const result = await useCaseInstance.sendEventMessages({
            event: EVENT_TYPE,
            payload: {},
            channelSlug: "channel-slug",
            recipientEmail: "recipient@test.com",
          });

          expect(result._unsafeUnwrapErr()[0]).toBeInstanceOf(
            SendEventMessagesUseCase.IbanGuardBlockedError,
          );
          expect(emailSender.mockSendEmailMethod).toHaveBeenCalledOnce();

          const [{ mailData, smtpSettings }] = emailSender.mockSendEmailMethod.mock.calls[0];

          expect(mailData.to).toBe("owner@shop.test");
          expect(mailData.from).toBe("Shop <shop@shop.test>");
          expect(mailData.subject).toContain("Alerte sécurité");
          expect(smtpSettings.host).toBe("localhost");
        });
      });
    });
  });
});
