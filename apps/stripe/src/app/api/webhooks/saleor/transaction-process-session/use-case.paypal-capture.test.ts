import { ok } from "neverthrow";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockedSaleorAppId, mockedSaleorChannelId } from "@/__tests__/mocks/constants";
import { mockAuthData } from "@/__tests__/mocks/mock-auth-data";
import { getMockedRecordedTransaction } from "@/__tests__/mocks/mocked-recorded-transaction";
import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { mockedStripePaymentIntentsApi } from "@/__tests__/mocks/mocked-stripe-payment-intents-api";
import { MockedTransactionRecorder } from "@/__tests__/mocks/mocked-transaction-recorder";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { getMockedTransactionProcessSessionEvent } from "@/__tests__/mocks/saleor-events/transaction-process-session-event";
import { IPaypalCaptureTrigger } from "@/modules/paypal-capture/capture-check-scheduler";
import { IStripePaymentIntentsApiFactory } from "@/modules/stripe/types";

import { TransactionProcessSessionUseCase } from "./use-case";
import { TransactionProcessSessionUseCaseResponses } from "./use-case-response";

/*
 * A3d "soon" trigger on TRANSACTION_PROCESS_SESSION (gate on only): when the app answers
 * AUTHORIZATION_SUCCESS (a paypal-only PaymentIntent in requires_capture after the PayPal
 * approval), it schedules capture checks of that PaymentIntent. Gate off: no trigger, today's
 * answer.
 */

const stripePaymentIntentsApiFactory = {
  create: () => mockedStripePaymentIntentsApi,
} satisfies IStripePaymentIntentsApiFactory;

const trigger = { onAuthorizationSuccess: vi.fn() } satisfies IPaypalCaptureTrigger;

const livePaymentIntent = (status: Stripe.PaymentIntent.Status) =>
  ({
    id: mockedStripePaymentIntentId.toString(),
    amount: 101_50,
    amount_capturable: status === "requires_capture" ? 101_50 : 0,
    amount_received: status === "succeeded" ? 101_50 : 0,
    currency: "eur",
    status,
    metadata: { saleor_payment_policy: "paypal-only" },
  }) as unknown as Stripe.PaymentIntent;

const execute = async (status: Stripe.PaymentIntent.Status, paypalCaptureTrigger?: IPaypalCaptureTrigger | null) => {
  const recorder = new MockedTransactionRecorder();

  await recorder.recordTransaction(mockAuthData, getMockedRecordedTransaction({ selectedPaymentMethod: "paypal" }));
  vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent).mockResolvedValueOnce(ok(livePaymentIntent(status)));

  const useCase = new TransactionProcessSessionUseCase({
    appConfigRepo: mockedAppConfigRepo,
    stripePaymentIntentsApiFactory,
    transactionRecorder: recorder,
    ...(paypalCaptureTrigger === undefined ? {} : { paypalCaptureTrigger }),
  });

  return useCase.execute({
    saleorApiUrl: mockedSaleorApiUrl,
    appId: mockedSaleorAppId,
    event: getMockedTransactionProcessSessionEvent({ actionType: "CHARGE" }),
  });
};

describe("TransactionProcessSessionUseCase: A3d soon trigger", () => {
  beforeEach(() => {
    trigger.onAuthorizationSuccess.mockReset();
  });

  it("schedules capture checks when it answers AUTHORIZATION_SUCCESS", async () => {
    const result = await execute("requires_capture", trigger);

    const response = result._unsafeUnwrap();

    expect(response).toBeInstanceOf(TransactionProcessSessionUseCaseResponses.Success);
    expect(response.transactionResult.result).toBe("AUTHORIZATION_SUCCESS");
    expect(trigger.onAuthorizationSuccess.mock.calls).toStrictEqual([
      [
        {
          saleorApiUrl: mockedSaleorApiUrl,
          appId: mockedSaleorAppId,
          paymentIntent: livePaymentIntent("requires_capture"),
          stripeConfig: { channelId: mockedSaleorChannelId },
        },
      ],
    ]);
  });

  it.each(["succeeded", "requires_action", "processing", "canceled"] as const)(
    "schedules nothing for a %s PaymentIntent",
    async (status) => {
      await execute(status, trigger);

      expect(trigger.onAuthorizationSuccess).not.toHaveBeenCalled();
    },
  );

  it("still answers AUTHORIZATION_SUCCESS when the trigger throws", async () => {
    trigger.onAuthorizationSuccess.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    const result = await execute("requires_capture", trigger);

    expect(result._unsafeUnwrap().transactionResult.result).toBe("AUTHORIZATION_SUCCESS");
  });

  it.each([undefined, null])("gate off (trigger %s): today's answer", async (gateOffTrigger) => {
    const result = await execute("requires_capture", gateOffTrigger);

    expect(result._unsafeUnwrap()).toBeInstanceOf(TransactionProcessSessionUseCaseResponses.Success);
    expect(result._unsafeUnwrap().transactionResult.result).toBe("AUTHORIZATION_SUCCESS");
  });
});
