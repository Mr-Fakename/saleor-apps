import { APL } from "@saleor/app-sdk/APL";
import { err, ok } from "neverthrow";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockAdyenWebhookUrl, mockedConfigurationId, mockedSaleorAppId, mockedSaleorTransactionId } from "@/__tests__/mocks/constants";
import { mockAuthData } from "@/__tests__/mocks/mock-auth-data";
import { MockedTransactionRecorder } from "@/__tests__/mocks/mocked-transaction-recorder";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { getMockedPaymentIntentAmountCapturableUpdatedEvent } from "@/__tests__/mocks/stripe-events/mocked-payment-intent-amount-capturable-updated";
import { getMockedPaymentIntentSucceededEvent } from "@/__tests__/mocks/stripe-events/mocked-payment-intent-succeeded";
import { IPaypalCaptureTrigger } from "@/modules/paypal-capture/capture-check-scheduler";
import { createResolvedTransactionFlow } from "@/modules/resolved-transaction-flow";
import { createSaleorTransactionFlow } from "@/modules/saleor/saleor-transaction-flow";
import {
  ITransactionEventReporter,
  TransactionEventReporterErrors,
} from "@/modules/saleor/transaction-event-reporter";
import { ITransactionEventsFetcher } from "@/modules/saleor/transaction-events-fetcher";
import { createStripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";
import { StripeWebhookManager } from "@/modules/stripe/stripe-webhook-manager";
import { IStripeEventVerify } from "@/modules/stripe/types";
import { RecordedTransaction } from "@/modules/transactions-recording/domain/recorded-transaction";

import { StripeWebhookUseCase } from "./use-case";
import { WebhookParams } from "./webhook-params";

/*
 * Two A3d changes on the Stripe webhook:
 * 1. Remainder report (ALL shops, not gated; spike S2): payment_intent.succeeded with
 *    amount_received < amount also reports CANCEL_SUCCESS for the released remainder under
 *    "<pi>:released". Full captures send exactly what they sent before.
 * 2. "Soon" trigger (gate on only): an AUTHORIZATION_SUCCESS report schedules capture checks.
 */

const mockApl = { get: vi.fn(), set: vi.fn(), delete: vi.fn(), getAll: vi.fn() } satisfies APL;
const eventVerify = { verifyEvent: vi.fn() } satisfies IStripeEventVerify;
const webhookParams = WebhookParams.createFromWebhookUrl(mockAdyenWebhookUrl)._unsafeUnwrap();
const mockEventReporter = { reportTransactionEvent: vi.fn() } satisfies ITransactionEventReporter;
const mockEventsFetcher = { fetchTransactionEvents: vi.fn() } satisfies ITransactionEventsFetcher;
const mockTransactionRecorder = new MockedTransactionRecorder();
const trigger = { onAuthorizationSuccess: vi.fn() } satisfies IPaypalCaptureTrigger;

const createUseCase = (paypalCaptureTrigger?: IPaypalCaptureTrigger | null) =>
  new StripeWebhookUseCase({
    apl: mockApl,
    appConfigRepo: mockedAppConfigRepo,
    webhookEventVerifyFactory: () => eventVerify,
    transactionEventReporterFactory: () => mockEventReporter,
    transactionEventsFetcherFactory: () => mockEventsFetcher,
    transactionRecorder: mockTransactionRecorder,
    webhookManager: new StripeWebhookManager(),
    ...(paypalCaptureTrigger === undefined ? {} : { paypalCaptureTrigger }),
  });

const execute = (useCase: StripeWebhookUseCase) =>
  useCase.execute({ rawBody: "BODY", signatureHeader: "SIGNATURE", webhookParams });

const recordTransaction = (paymentIntentId: string) => {
  const id = createStripePaymentIntentId(paymentIntentId);

  mockTransactionRecorder.transactions = {
    [id]: new RecordedTransaction({
      saleorTransactionId: mockedSaleorTransactionId,
      stripePaymentIntentId: id,
      saleorTransactionFlow: createSaleorTransactionFlow("CHARGE"),
      resolvedTransactionFlow: createResolvedTransactionFlow("CHARGE"),
      selectedPaymentMethod: "paypal",
    }),
  };
};

/** A partial capture of 60.00 on an authorization of 100.00 (spike S2). */
const partialCaptureEvent = (): Stripe.PaymentIntentSucceededEvent => {
  const event = getMockedPaymentIntentSucceededEvent();

  return {
    ...event,
    data: {
      object: { ...event.data.object, currency: "eur", amount: 100_00, amount_received: 60_00, amount_capturable: 0 },
    },
  };
};

const fullCaptureEvent = (): Stripe.PaymentIntentSucceededEvent => {
  const event = getMockedPaymentIntentSucceededEvent();

  return {
    ...event,
    data: {
      object: { ...event.data.object, currency: "eur", amount: 100_00, amount_received: 100_00, amount_capturable: 0 },
    },
  };
};

const reported = () => vi.mocked(mockEventReporter.reportTransactionEvent).mock.calls.map(([input]) => input);

const alreadyReported = () =>
  err(new TransactionEventReporterErrors.AlreadyReportedError("Event already reported"));

describe("StripeWebhookUseCase: released remainder after a partial capture (S2, all shops)", () => {
  beforeEach(() => {
    mockApl.get.mockImplementation(async () => mockAuthData);
    mockTransactionRecorder.reset();
  });

  it("reports CHARGE_SUCCESS, then CANCEL_SUCCESS for the 40.00 Stripe released, under <pi>:released", async () => {
    const event = partialCaptureEvent();

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));
    recordTransaction(event.data.object.id);
    mockEventReporter.reportTransactionEvent.mockResolvedValue(ok({ createdEventId: "EV" }));

    const result = await execute(createUseCase());

    expect(result.isOk()).toBe(true);
    expect(reported().map((r) => [r.type, r.pspReference, r.amount.amount])).toStrictEqual([
      ["CHARGE_SUCCESS", "pi_TEST_TEST_TEST", 60],
      ["CANCEL_SUCCESS", "pi_TEST_TEST_TEST:released", 40],
    ]);
    expect(reported()[1]).toMatchObject({
      transactionId: mockedSaleorTransactionId,
      actions: null,
      time: new Date(event.created * 1000).toISOString(),
    });
  });

  it("still reports the remainder when the CHARGE_SUCCESS was already recorded (sync charge answer first)", async () => {
    const event = partialCaptureEvent();

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));
    recordTransaction(event.data.object.id);
    mockEventReporter.reportTransactionEvent
      .mockResolvedValueOnce(alreadyReported())
      .mockResolvedValueOnce(ok({ createdEventId: "EV" }));

    const result = await execute(createUseCase());

    expect(result.isOk()).toBe(true);
    expect(reported().map((r) => r.type)).toStrictEqual(["CHARGE_SUCCESS", "CANCEL_SUCCESS"]);
  });

  it("is idempotent: a remainder Saleor already recorded is a success (Stripe re-sent the event)", async () => {
    const event = partialCaptureEvent();

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));
    recordTransaction(event.data.object.id);
    mockEventReporter.reportTransactionEvent.mockResolvedValue(alreadyReported());

    const result = await execute(createUseCase());

    expect(result._unsafeUnwrap().statusCode).toBe(200);
    expect(reported()).toHaveLength(2);
  });

  it("answers 500 when the remainder cannot be reported, so Stripe re-sends the event", async () => {
    const event = partialCaptureEvent();

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));
    recordTransaction(event.data.object.id);
    mockEventReporter.reportTransactionEvent
      .mockResolvedValueOnce(ok({ createdEventId: "EV" }))
      .mockResolvedValueOnce(err(new TransactionEventReporterErrors.ServerError("Saleor down")));

    const result = await execute(createUseCase());

    expect(result._unsafeUnwrapErr().statusCode).toBe(500);
  });

  it("sends nothing more for a full capture: the reports are exactly today's (one CHARGE_SUCCESS)", async () => {
    const event = fullCaptureEvent();

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));
    recordTransaction(event.data.object.id);
    mockEventReporter.reportTransactionEvent.mockResolvedValue(ok({ createdEventId: "EV" }));

    await execute(createUseCase());

    expect(reported().map((r) => [r.type, r.pspReference, r.amount.amount])).toStrictEqual([
      ["CHARGE_SUCCESS", "pi_TEST_TEST_TEST", 100],
    ]);
  });

  it("does not report a remainder when the CHARGE_SUCCESS report failed (the webhook fails first)", async () => {
    const event = partialCaptureEvent();

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));
    recordTransaction(event.data.object.id);
    mockEventReporter.reportTransactionEvent.mockResolvedValue(
      err(new TransactionEventReporterErrors.ServerError("Saleor down")),
    );

    const result = await execute(createUseCase());

    expect(result._unsafeUnwrapErr().statusCode).toBe(500);
    expect(reported()).toHaveLength(1);
  });
});

describe("StripeWebhookUseCase: A3d soon trigger (gate on only)", () => {
  beforeEach(() => {
    mockApl.get.mockImplementation(async () => mockAuthData);
    mockTransactionRecorder.reset();
    mockEventReporter.reportTransactionEvent.mockResolvedValue(ok({ createdEventId: "EV" }));
  });

  it("schedules capture checks after reporting AUTHORIZATION_SUCCESS", async () => {
    const event = getMockedPaymentIntentAmountCapturableUpdatedEvent();

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));
    recordTransaction(event.data.object.id);

    const result = await execute(createUseCase(trigger));

    expect(result.isOk()).toBe(true);
    expect(trigger.onAuthorizationSuccess.mock.calls).toStrictEqual([
      [
        {
          saleorApiUrl: mockedSaleorApiUrl,
          appId: mockedSaleorAppId,
          paymentIntent: event.data.object,
          stripeConfig: { configId: mockedConfigurationId },
        },
      ],
    ]);
  });

  it("schedules them too when Saleor already had the AUTHORIZATION_SUCCESS", async () => {
    const event = getMockedPaymentIntentAmountCapturableUpdatedEvent();

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));
    recordTransaction(event.data.object.id);
    mockEventReporter.reportTransactionEvent.mockResolvedValue(alreadyReported());

    await execute(createUseCase(trigger));

    expect(trigger.onAuthorizationSuccess).toHaveBeenCalledOnce();
  });

  it("does not schedule anything for a CHARGE_SUCCESS", async () => {
    const event = fullCaptureEvent();

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));
    recordTransaction(event.data.object.id);

    await execute(createUseCase(trigger));

    expect(trigger.onAuthorizationSuccess).not.toHaveBeenCalled();
  });

  it("does not schedule anything when the report failed", async () => {
    const event = getMockedPaymentIntentAmountCapturableUpdatedEvent();

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));
    recordTransaction(event.data.object.id);
    mockEventReporter.reportTransactionEvent.mockResolvedValue(
      err(new TransactionEventReporterErrors.ServerError("Saleor down")),
    );

    await execute(createUseCase(trigger));

    expect(trigger.onAuthorizationSuccess).not.toHaveBeenCalled();
  });

  it("answers 200 even if the trigger throws: a scheduling bug never fails the webhook", async () => {
    const event = getMockedPaymentIntentAmountCapturableUpdatedEvent();

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));
    recordTransaction(event.data.object.id);
    trigger.onAuthorizationSuccess.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    const result = await execute(createUseCase(trigger));

    expect(result._unsafeUnwrap().statusCode).toBe(200);
  });

  it.each([undefined, null])("gate off (trigger %s): the same answer and reports as today", async (gateOffTrigger) => {
    const event = getMockedPaymentIntentAmountCapturableUpdatedEvent();

    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));
    recordTransaction(event.data.object.id);

    const result = await execute(createUseCase(gateOffTrigger));

    expect(result._unsafeUnwrap().statusCode).toBe(200);
    expect(reported().map((r) => r.type)).toStrictEqual(["AUTHORIZATION_SUCCESS"]);
  });
});
