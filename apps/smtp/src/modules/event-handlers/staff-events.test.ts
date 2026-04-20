import { ok, okAsync } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { notifyEventMapping } from "../../lib/notify-event-types";
import { SmtpConfiguration } from "../smtp/configuration/smtp-config-schema";
import {
  FilterConfigurationsArgs,
  IGetSmtpConfiguration,
} from "../smtp/configuration/smtp-configuration.service";
import { defaultMjmlSubjectTemplates, defaultMjmlTemplates } from "../smtp/default-templates";
import { CompileArgs, EmailCompiler, IEmailCompiler } from "../smtp/services/email-compiler";
import { HandlebarsTemplateCompiler } from "../smtp/services/handlebars-template-compiler";
import { HtmlToTextCompiler } from "../smtp/services/html-to-text-compiler";
import { MjmlCompiler } from "../smtp/services/mjml-compiler";
import { ISMTPEmailSender, SendMailArgs } from "../smtp/services/smtp-email-sender";
import { examplePayloads } from "./default-payloads";
import {
  MessageEventTypes,
  messageEventTypes,
  messageEventTypesLabels,
} from "./message-event-types";
import { SendEventMessagesUseCase } from "./use-case/send-event-messages.use-case";

/* Helper: create a full SMTP configuration with all events active */
function createActiveSmtpConfig(overrides: Partial<SmtpConfiguration> = {}): SmtpConfiguration {
  return {
    id: "test-config-id",
    active: true,
    name: "Test Config",
    senderName: "Test Sender",
    senderEmail: "sender@test.com",
    smtpHost: "localhost",
    smtpPort: "1025",
    encryption: "NONE",
    channels: {
      override: false,
      channels: [],
      mode: "restrict",
    },
    events: messageEventTypes.map((eventType) => ({
      active: true,
      eventType,
      template: defaultMjmlTemplates[eventType],
      subject: defaultMjmlSubjectTemplates[eventType],
    })),
    ...overrides,
  };
}

/* Mock implementations */
class MockEmailCompiler implements IEmailCompiler {
  mockCompileMethod = vi.fn<(args: CompileArgs) => ReturnType<IEmailCompiler["compile"]>>();
  compile = this.mockCompileMethod;
}

class MockSmtpSender implements ISMTPEmailSender {
  mockSendMethod = vi.fn<(args: SendMailArgs) => ReturnType<ISMTPEmailSender["sendEmailWithSmtp"]>>();
  sendEmailWithSmtp = this.mockSendMethod;
}

class MockConfigService implements IGetSmtpConfiguration {
  mockGetConfigurations = vi.fn<
    (filter?: FilterConfigurationsArgs) => ReturnType<IGetSmtpConfiguration["getConfigurations"]>
  >();
  getConfigurations = this.mockGetConfigurations;
}

describe("Staff Events", () => {
  /*
   * 1. All 20 event types have required resources
   */
  describe("Event type completeness", () => {
    it("all messageEventTypes have a default MJML template", () => {
      for (const eventType of messageEventTypes) {
        expect(defaultMjmlTemplates[eventType]).toBeDefined();
        expect(defaultMjmlTemplates[eventType].length).toBeGreaterThan(0);
      }
    });

    it("all messageEventTypes have a default subject template", () => {
      for (const eventType of messageEventTypes) {
        expect(defaultMjmlSubjectTemplates[eventType]).toBeDefined();
        expect(defaultMjmlSubjectTemplates[eventType].length).toBeGreaterThan(0);
      }
    });

    it("all messageEventTypes have an example payload", () => {
      for (const eventType of messageEventTypes) {
        expect(examplePayloads[eventType]).toBeDefined();
      }
    });

    it("messageEventTypes array contains exactly 20 event types", () => {
      expect(messageEventTypes).toHaveLength(20);
    });

    it("labels record covers all event types", () => {
      for (const eventType of messageEventTypes) {
        expect(messageEventTypesLabels[eventType]).toBeDefined();
        expect(typeof messageEventTypesLabels[eventType]).toBe("string");
      }
    });
  });

  /*
   * 2. Notify event mapping covers all NOTIFY-routed events
   */
  describe("Notify event mapping", () => {
    const expectedNotifyMappings: Record<string, MessageEventTypes> = {
      account_confirmation: "ACCOUNT_CONFIRMATION",
      account_delete: "ACCOUNT_DELETE",
      account_password_reset: "ACCOUNT_PASSWORD_RESET",
      account_change_email_request: "ACCOUNT_CHANGE_EMAIL_REQUEST",
      account_change_email_confirm: "ACCOUNT_CHANGE_EMAIL_CONFIRM",
      account_set_customer_password: "ACCOUNT_SET_CUSTOMER_PASSWORD",
      account_set_staff_password: "ACCOUNT_SET_STAFF_PASSWORD",
      account_staff_reset_password: "ACCOUNT_STAFF_RESET_PASSWORD",
      csv_export_success: "CSV_EXPORT_SUCCESS",
      csv_export_failed: "CSV_EXPORT_FAILED",
      order_fulfillment_update: "ORDER_FULFILLMENT_UPDATE",
      staff_order_confirmation: "STAFF_ORDER_CONFIRMATION",
    };

    it("maps all expected Saleor notify events", () => {
      for (const [saleorEvent, messageEvent] of Object.entries(expectedNotifyMappings)) {
        expect(notifyEventMapping[saleorEvent]).toBe(messageEvent);
      }
    });

    it("has exactly 12 notify event mappings", () => {
      expect(Object.keys(notifyEventMapping)).toHaveLength(12);
    });

    it("all mapped values are valid MessageEventTypes", () => {
      for (const mappedEvent of Object.values(notifyEventMapping)) {
        expect(messageEventTypes).toContain(mappedEvent);
      }
    });
  });

  /*
   * 3. Template compilation for all event types
   */
  describe("Template compilation for all 20 event types", () => {
    const compiler = new EmailCompiler(
      new HandlebarsTemplateCompiler(),
      new HtmlToTextCompiler(),
      new MjmlCompiler(),
    );

    for (const eventType of messageEventTypes) {
      it(`compiles default template for ${eventType} without errors`, () => {
        const result = compiler.compile({
          event: eventType,
          recipientEmail: "test@example.com",
          payload: examplePayloads[eventType],
          bodyTemplate: defaultMjmlTemplates[eventType],
          subjectTemplate: defaultMjmlSubjectTemplates[eventType],
          senderEmail: "sender@example.com",
          senderName: "Test Store",
        });

        expect(result.isOk()).toBe(true);

        const email = result._unsafeUnwrap();

        expect(email.to).toBe("test@example.com");
        expect(email.from).toBe("Test Store <sender@example.com>");
        expect(email.subject.length).toBeGreaterThan(0);
        expect(email.html.length).toBeGreaterThan(0);
        expect(email.text.length).toBeGreaterThan(0);
      });
    }
  });

  /*
   * 4. Staff event-specific template content validation
   */
  describe("Staff event template content", () => {
    const compiler = new EmailCompiler(
      new HandlebarsTemplateCompiler(),
      new HtmlToTextCompiler(),
      new MjmlCompiler(),
    );

    it("ACCOUNT_SET_CUSTOMER_PASSWORD template includes password set URL", () => {
      const result = compiler.compile({
        event: "ACCOUNT_SET_CUSTOMER_PASSWORD",
        recipientEmail: "test@example.com",
        payload: examplePayloads.ACCOUNT_SET_CUSTOMER_PASSWORD,
        bodyTemplate: defaultMjmlTemplates.ACCOUNT_SET_CUSTOMER_PASSWORD,
        subjectTemplate: defaultMjmlSubjectTemplates.ACCOUNT_SET_CUSTOMER_PASSWORD,
        senderEmail: "sender@example.com",
        senderName: "Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.html).toContain("set-password");
      expect(email.subject).toContain("password");
    });

    it("ACCOUNT_SET_STAFF_PASSWORD template includes staff-specific language", () => {
      const result = compiler.compile({
        event: "ACCOUNT_SET_STAFF_PASSWORD",
        recipientEmail: "staff@example.com",
        payload: examplePayloads.ACCOUNT_SET_STAFF_PASSWORD,
        bodyTemplate: defaultMjmlTemplates.ACCOUNT_SET_STAFF_PASSWORD,
        subjectTemplate: defaultMjmlSubjectTemplates.ACCOUNT_SET_STAFF_PASSWORD,
        senderEmail: "sender@example.com",
        senderName: "Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.html).toContain("staff");
      expect(email.subject.toLowerCase()).toContain("staff");
    });

    it("CSV_EXPORT_SUCCESS template includes download link", () => {
      const result = compiler.compile({
        event: "CSV_EXPORT_SUCCESS",
        recipientEmail: "staff@example.com",
        payload: examplePayloads.CSV_EXPORT_SUCCESS,
        bodyTemplate: defaultMjmlTemplates.CSV_EXPORT_SUCCESS,
        subjectTemplate: defaultMjmlSubjectTemplates.CSV_EXPORT_SUCCESS,
        senderEmail: "sender@example.com",
        senderName: "Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.html).toContain("csv");
      expect(email.subject.toLowerCase()).toContain("csv");
    });

    it("STAFF_ORDER_CONFIRMATION template includes order number", () => {
      const result = compiler.compile({
        event: "STAFF_ORDER_CONFIRMATION",
        recipientEmail: "staff@example.com",
        payload: examplePayloads.STAFF_ORDER_CONFIRMATION,
        bodyTemplate: defaultMjmlTemplates.STAFF_ORDER_CONFIRMATION,
        subjectTemplate: defaultMjmlSubjectTemplates.STAFF_ORDER_CONFIRMATION,
        senderEmail: "sender@example.com",
        senderName: "Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.html).toContain("231");
      expect(email.subject).toContain("231");
    });
  });

  /*
   * 5. SendEventMessagesUseCase flows for new events
   */
  describe("SendEventMessagesUseCase with staff events", () => {
    let mockCompiler: MockEmailCompiler;
    let mockSender: MockSmtpSender;
    let mockConfigService: MockConfigService;
    let useCase: SendEventMessagesUseCase;

    beforeEach(() => {
      vi.resetAllMocks();

      mockCompiler = new MockEmailCompiler();
      mockSender = new MockSmtpSender();
      mockConfigService = new MockConfigService();

      mockCompiler.mockCompileMethod.mockReturnValue(
        ok({
          from: "Store <sender@example.com>",
          to: "user@example.com",
          subject: "Test Subject",
          html: "<html>test</html>",
          text: "test",
        }),
      );

      mockSender.mockSendMethod.mockResolvedValue({ response: "250 OK" });

      mockConfigService.mockGetConfigurations.mockReturnValue(
        okAsync([createActiveSmtpConfig()]),
      );

      useCase = new SendEventMessagesUseCase({
        emailCompiler: mockCompiler,
        emailSender: mockSender,
        smtpConfigurationService: mockConfigService,
      });
    });

    const staffEvents: MessageEventTypes[] = [
      "ACCOUNT_SET_CUSTOMER_PASSWORD",
      "ACCOUNT_SET_STAFF_PASSWORD",
      "ACCOUNT_STAFF_RESET_PASSWORD",
      "CSV_EXPORT_SUCCESS",
      "CSV_EXPORT_FAILED",
      "STAFF_ORDER_CONFIRMATION",
    ];

    for (const eventType of staffEvents) {
      it(`successfully processes ${eventType} event`, async () => {
        const result = await useCase.sendEventMessages({
          channelSlug: "default-channel",
          event: eventType,
          payload: examplePayloads[eventType],
          recipientEmail: "user@example.com",
        });

        expect(result.isOk()).toBe(true);
        expect(mockCompiler.mockCompileMethod).toHaveBeenCalledTimes(1);
        expect(mockSender.mockSendMethod).toHaveBeenCalledTimes(1);
      });
    }

    it("returns NoOpError when event is disabled in config", async () => {
      const config = createActiveSmtpConfig();

      config.events = config.events.map((e) =>
        e.eventType === "ACCOUNT_SET_STAFF_PASSWORD" ? { ...e, active: false } : e,
      );
      mockConfigService.mockGetConfigurations.mockReturnValue(okAsync([config]));

      const result = await useCase.sendEventMessages({
        channelSlug: "default-channel",
        event: "ACCOUNT_SET_STAFF_PASSWORD",
        payload: examplePayloads.ACCOUNT_SET_STAFF_PASSWORD,
        recipientEmail: "staff@example.com",
      });

      expect(result.isErr()).toBe(true);

      const errors = result._unsafeUnwrapErr();

      expect(errors[0]).toBeInstanceOf(SendEventMessagesUseCase.EventConfigNotActiveError);
    });

    it("returns EventSettingsMissingError when event config is missing entirely", async () => {
      const config = createActiveSmtpConfig();

      config.events = config.events.filter((e) => e.eventType !== "CSV_EXPORT_SUCCESS");
      mockConfigService.mockGetConfigurations.mockReturnValue(okAsync([config]));

      const result = await useCase.sendEventMessages({
        channelSlug: "default-channel",
        event: "CSV_EXPORT_SUCCESS",
        payload: examplePayloads.CSV_EXPORT_SUCCESS,
        recipientEmail: "staff@example.com",
      });

      expect(result.isErr()).toBe(true);

      const errors = result._unsafeUnwrapErr();

      expect(errors[0]).toBeInstanceOf(SendEventMessagesUseCase.EventSettingsMissingError);
    });
  });

  /*
   * 6. Complete user flow scenarios (end-to-end through templates)
   */
  describe("User flow scenarios — template rendering", () => {
    const compiler = new EmailCompiler(
      new HandlebarsTemplateCompiler(),
      new HtmlToTextCompiler(),
      new MjmlCompiler(),
    );

    it("Scenario: user forgot password → ACCOUNT_PASSWORD_RESET", () => {
      const payload = {
        ...examplePayloads.ACCOUNT_PASSWORD_RESET,
        user: { ...examplePayloads.ACCOUNT_PASSWORD_RESET.user, first_name: "Alice" },
        reset_url: "https://store.com/reset?token=abc123",
      };

      const result = compiler.compile({
        event: "ACCOUNT_PASSWORD_RESET",
        recipientEmail: "alice@example.com",
        payload,
        bodyTemplate: defaultMjmlTemplates.ACCOUNT_PASSWORD_RESET,
        subjectTemplate: defaultMjmlSubjectTemplates.ACCOUNT_PASSWORD_RESET,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.to).toBe("alice@example.com");
      expect(email.html).toContain("Alice");
      expect(email.html).toContain("store.com/reset?token");
      expect(email.html).toContain("abc123");
      expect(email.subject.toLowerCase()).toContain("password");
    });

    it("Scenario: user wants to change email → ACCOUNT_CHANGE_EMAIL_REQUEST", () => {
      const payload = {
        ...examplePayloads.ACCOUNT_CHANGE_EMAIL_REQUEST,
        user: { ...examplePayloads.ACCOUNT_CHANGE_EMAIL_REQUEST.user, first_name: "Bob" },
        new_email: "newemail@example.com",
        redirect_url: "https://store.com/confirm-email?token=xyz",
      };

      const result = compiler.compile({
        event: "ACCOUNT_CHANGE_EMAIL_REQUEST",
        recipientEmail: "bob@example.com",
        payload,
        bodyTemplate: defaultMjmlTemplates.ACCOUNT_CHANGE_EMAIL_REQUEST,
        subjectTemplate: defaultMjmlSubjectTemplates.ACCOUNT_CHANGE_EMAIL_REQUEST,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.html).toContain("Bob");
      expect(email.html).toContain("newemail@example.com");
      expect(email.html).toContain("store.com/confirm-email?token");
      expect(email.html).toContain("xyz");
    });

    it("Scenario: order confirmed → ORDER_CONFIRMED", () => {
      const result = compiler.compile({
        event: "ORDER_CONFIRMED",
        recipientEmail: "customer@example.com",
        payload: examplePayloads.ORDER_CONFIRMED,
        bodyTemplate: defaultMjmlTemplates.ORDER_CONFIRMED,
        subjectTemplate: defaultMjmlSubjectTemplates.ORDER_CONFIRMED,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.subject).toContain("198");
      expect(email.html).toContain("198");
    });

    it("Scenario: order fulfilled → ORDER_FULFILLED", () => {
      const result = compiler.compile({
        event: "ORDER_FULFILLED",
        recipientEmail: "customer@example.com",
        payload: examplePayloads.ORDER_FULFILLED,
        bodyTemplate: defaultMjmlTemplates.ORDER_FULFILLED,
        subjectTemplate: defaultMjmlSubjectTemplates.ORDER_FULFILLED,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.subject).toContain("198");
      expect(email.html).toContain("fulfilled");
    });

    it("Scenario: order fully paid → ORDER_FULLY_PAID", () => {
      const result = compiler.compile({
        event: "ORDER_FULLY_PAID",
        recipientEmail: "customer@example.com",
        payload: examplePayloads.ORDER_FULLY_PAID,
        bodyTemplate: defaultMjmlTemplates.ORDER_FULLY_PAID,
        subjectTemplate: defaultMjmlSubjectTemplates.ORDER_FULLY_PAID,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.subject).toContain("198");
      expect(email.html).toContain("paid");
    });

    it("Scenario: order cancelled → ORDER_CANCELLED", () => {
      const result = compiler.compile({
        event: "ORDER_CANCELLED",
        recipientEmail: "customer@example.com",
        payload: examplePayloads.ORDER_CANCELLED,
        bodyTemplate: defaultMjmlTemplates.ORDER_CANCELLED,
        subjectTemplate: defaultMjmlSubjectTemplates.ORDER_CANCELLED,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.subject).toContain("198");
      expect(email.html).toContain("cancelled");
    });

    it("Scenario: order refunded → ORDER_REFUNDED", () => {
      const result = compiler.compile({
        event: "ORDER_REFUNDED",
        recipientEmail: "customer@example.com",
        payload: examplePayloads.ORDER_REFUNDED,
        bodyTemplate: defaultMjmlTemplates.ORDER_REFUNDED,
        subjectTemplate: defaultMjmlSubjectTemplates.ORDER_REFUNDED,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.subject).toContain("198");
      expect(email.html).toContain("refunded");
    });

    it("Scenario: fulfillment update with tracking → ORDER_FULFILLMENT_UPDATE", () => {
      const result = compiler.compile({
        event: "ORDER_FULFILLMENT_UPDATE",
        recipientEmail: "customer@example.com",
        payload: examplePayloads.ORDER_FULFILLMENT_UPDATE,
        bodyTemplate: defaultMjmlTemplates.ORDER_FULFILLMENT_UPDATE,
        subjectTemplate: defaultMjmlSubjectTemplates.ORDER_FULFILLMENT_UPDATE,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.subject).toContain("231");
      expect(email.html).toContain("1111-1111-1111-1111");
    });

    it("Scenario: invoice sent → INVOICE_SENT", () => {
      const result = compiler.compile({
        event: "INVOICE_SENT",
        recipientEmail: "customer@example.com",
        payload: examplePayloads.INVOICE_SENT,
        bodyTemplate: defaultMjmlTemplates.INVOICE_SENT,
        subjectTemplate: defaultMjmlSubjectTemplates.INVOICE_SENT,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.subject.toLowerCase()).toContain("invoice");
    });

    it("Scenario: account confirmation → ACCOUNT_CONFIRMATION", () => {
      const payload = {
        ...examplePayloads.ACCOUNT_CONFIRMATION,
        user: { ...examplePayloads.ACCOUNT_CONFIRMATION.user, first_name: "Charlie" },
        confirm_url: "https://store.com/confirm?token=def456",
      };

      const result = compiler.compile({
        event: "ACCOUNT_CONFIRMATION",
        recipientEmail: "charlie@example.com",
        payload,
        bodyTemplate: defaultMjmlTemplates.ACCOUNT_CONFIRMATION,
        subjectTemplate: defaultMjmlSubjectTemplates.ACCOUNT_CONFIRMATION,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.html).toContain("Charlie");
      expect(email.html).toContain("store.com/confirm?token");
      expect(email.html).toContain("def456");
    });

    it("Scenario: account delete request → ACCOUNT_DELETE", () => {
      const result = compiler.compile({
        event: "ACCOUNT_DELETE",
        recipientEmail: "user@example.com",
        payload: examplePayloads.ACCOUNT_DELETE,
        bodyTemplate: defaultMjmlTemplates.ACCOUNT_DELETE,
        subjectTemplate: defaultMjmlSubjectTemplates.ACCOUNT_DELETE,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.subject.toLowerCase()).toContain("delet");
    });

    it("Scenario: staff password set → ACCOUNT_SET_STAFF_PASSWORD", () => {
      const result = compiler.compile({
        event: "ACCOUNT_SET_STAFF_PASSWORD",
        recipientEmail: "staff@example.com",
        payload: examplePayloads.ACCOUNT_SET_STAFF_PASSWORD,
        bodyTemplate: defaultMjmlTemplates.ACCOUNT_SET_STAFF_PASSWORD,
        subjectTemplate: defaultMjmlSubjectTemplates.ACCOUNT_SET_STAFF_PASSWORD,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.html).toContain("Jane");
      expect(email.html).toContain("staff");
    });

    it("Scenario: CSV export completed → CSV_EXPORT_SUCCESS", () => {
      const result = compiler.compile({
        event: "CSV_EXPORT_SUCCESS",
        recipientEmail: "staff@example.com",
        payload: examplePayloads.CSV_EXPORT_SUCCESS,
        bodyTemplate: defaultMjmlTemplates.CSV_EXPORT_SUCCESS,
        subjectTemplate: defaultMjmlSubjectTemplates.CSV_EXPORT_SUCCESS,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.html).toContain("products-2024-01-15.csv");
    });

    it("Scenario: CSV export failed → CSV_EXPORT_FAILED", () => {
      const result = compiler.compile({
        event: "CSV_EXPORT_FAILED",
        recipientEmail: "staff@example.com",
        payload: examplePayloads.CSV_EXPORT_FAILED,
        bodyTemplate: defaultMjmlTemplates.CSV_EXPORT_FAILED,
        subjectTemplate: defaultMjmlSubjectTemplates.CSV_EXPORT_FAILED,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.subject.toLowerCase()).toContain("failed");
    });

    it("Scenario: new order → staff notification → STAFF_ORDER_CONFIRMATION", () => {
      const result = compiler.compile({
        event: "STAFF_ORDER_CONFIRMATION",
        recipientEmail: "staff@example.com",
        payload: examplePayloads.STAFF_ORDER_CONFIRMATION,
        bodyTemplate: defaultMjmlTemplates.STAFF_ORDER_CONFIRMATION,
        subjectTemplate: defaultMjmlSubjectTemplates.STAFF_ORDER_CONFIRMATION,
        senderEmail: "noreply@store.com",
        senderName: "My Store",
      });

      const email = result._unsafeUnwrap();

      expect(email.subject).toContain("231");
      expect(email.html).toContain("caitlin.johnson@example.com");
    });
  });
});
