import { err, ok } from "neverthrow";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockedSaleorAppId, mockedSaleorTransactionId } from "@/__tests__/mocks/constants";
import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { mockedStripePaymentIntentsApi } from "@/__tests__/mocks/mocked-stripe-payment-intents-api";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { getMockedTransactionChargeRequestedEvent } from "@/__tests__/mocks/saleor-events/transaction-charge-requested-event";
import { parseTransactionActionAnswer } from "@/__tests__/transaction-action-answer";
import {
  AppIsNotConfiguredResponse,
  BrokenAppResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import { TransactionChargeRequestedEventFragment } from "@/generated/graphql";
import { appContextContainer } from "@/lib/app-context";
import { IStripePaymentIntentsApiFactory } from "@/modules/stripe/types";
import { ChargeFailureResult } from "@/modules/transaction-result/failure-result";
import { ChargeSuccessResult } from "@/modules/transaction-result/success-result";

import { TransactionChargeRequestedUseCase } from "./use-case";
import {
  ChargeOutcomeUnknownResponse,
  TransactionChargeRequestedUseCaseResponses,
} from "./use-case-response";

const paymentIntent = (overrides: Partial<Stripe.PaymentIntent> = {}) =>
  ({
    id: mockedStripePaymentIntentId.toString(), // stripe doesn't expect to get branded type here
    object: "payment_intent",
    amount: 100_00,
    amount_capturable: 100_00,
    amount_received: 0,
    currency: "usd",
    status: "requires_capture",
    canceled_at: null,
    ...overrides,
  }) as Stripe.PaymentIntent;

const capturedPaymentIntent = (amountReceived: number) =>
  paymentIntent({ status: "succeeded", amount_capturable: 0, amount_received: amountReceived });

const chargeEvent = (amount: number): TransactionChargeRequestedEventFragment => ({
  ...getMockedTransactionChargeRequestedEvent(),
  action: { amount },
});

/** Stripe's answer to a capture of a PaymentIntent that is no longer `requires_capture`. */
const alreadyCapturedError = () =>
  new Stripe.errors.StripeInvalidRequestError({
    type: "invalid_request_error",
    code: "payment_intent_unexpected_state",
    message: "This PaymentIntent could not be captured because it has a status of succeeded.",
    statusCode: 400,
  });

describe("TransactionChargeRequestedUseCase", () => {
  // getResponse() needs the Stripe environment that the route sets for each request.
  beforeEach(() => {
    vi.spyOn(appContextContainer, "getContextValue").mockReturnValue({ stripeEnv: "LIVE" });
  });

  const stripePaymentIntentsApiFactory = {
    create: () => mockedStripePaymentIntentsApi,
  } satisfies IStripePaymentIntentsApiFactory;

  const execute = (event: TransactionChargeRequestedEventFragment) =>
    new TransactionChargeRequestedUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripePaymentIntentsApiFactory,
    }).execute({ saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId, event });

  const liveStatus = (...answers: Stripe.PaymentIntent[]) => {
    const spy = vi.spyOn(mockedStripePaymentIntentsApi, "getPaymentIntentForTransactionAction");

    answers.forEach((answer) => spy.mockImplementationOnce(async () => ok(answer)));

    return spy;
  };

  const captureAnswers = (...answers: Array<Stripe.PaymentIntent | Error>) => {
    const spy = vi.spyOn(mockedStripePaymentIntentsApi, "capturePaymentIntent");

    answers.forEach((answer) =>
      spy.mockImplementationOnce(async () => (answer instanceof Error ? err(answer) : ok(answer))),
    );

    return spy;
  };

  /** The JSON Saleor receives for a sync answer; the result must be Ok. */
  const answerOf = async (result: Awaited<ReturnType<typeof execute>>) =>
    parseTransactionActionAnswer(await result._unsafeUnwrap().getResponse().json());

  describe("requires_capture: captures what Saleor asked for", () => {
    it("reads the live PaymentIntent, then captures action.amount (not the whole authorization) with the key capture:v1:<pi>:<amount>", async () => {
      const read = liveStatus(paymentIntent());
      const capture = captureAnswers(capturedPaymentIntent(60_00));

      const result = await execute(chargeEvent(60));

      expect(read).toHaveBeenCalledExactlyOnceWith({ id: mockedStripePaymentIntentId });
      expect(read.mock.invocationCallOrder[0]).toBeLessThan(capture.mock.invocationCallOrder[0]);
      expect(capture).toHaveBeenCalledExactlyOnceWith({
        id: mockedStripePaymentIntentId,
        amountToCapture: 60_00,
        idempotencyKey: "capture:v1:pi_TEST_TEST_TEST:6000",
      });

      const success = result._unsafeUnwrap();

      expect(success).toBeInstanceOf(TransactionChargeRequestedUseCaseResponses.Success);
      expect(success.transactionResult).toBeInstanceOf(ChargeSuccessResult);
      expect(await answerOf(result)).toMatchObject({
        result: "CHARGE_SUCCESS",
        amount: 60,
        pspReference: mockedStripePaymentIntentId,
      });
    });

    it("captures at most amount_capturable", async () => {
      liveStatus(paymentIntent({ amount_capturable: 80_00 }));
      const capture = captureAnswers(capturedPaymentIntent(80_00));

      const result = await execute(chargeEvent(100));

      expect(capture).toHaveBeenCalledExactlyOnceWith({
        id: mockedStripePaymentIntentId,
        amountToCapture: 80_00,
        idempotencyKey: "capture:v1:pi_TEST_TEST_TEST:8000",
      });
      expect(await answerOf(result)).toMatchObject({ result: "CHARGE_SUCCESS", amount: 80 });
    });

    it("converts the requested amount with the PaymentIntent currency's minor unit", async () => {
      liveStatus(paymentIntent({ currency: "jpy", amount: 5000, amount_capturable: 5000 }));
      const capture = captureAnswers(
        paymentIntent({
          currency: "jpy",
          amount: 5000,
          amount_capturable: 0,
          amount_received: 3000,
          status: "succeeded",
        }),
      );

      await execute(chargeEvent(3000));

      expect(capture.mock.calls[0][0]).toMatchObject({ amountToCapture: 3000 });
    });

    it("answers CHARGE_FAILURE without a Stripe write when Saleor asks for 0 (min(amount, authorized) in transactionRequestAction)", async () => {
      liveStatus(paymentIntent());
      const capture = captureAnswers();

      const result = await execute(chargeEvent(0));

      expect(capture).not.toHaveBeenCalled();
      expect(result._unsafeUnwrap()).toBeInstanceOf(
        TransactionChargeRequestedUseCaseResponses.Failure,
      );
      expect((await answerOf(result)).pspReference).not.toBe(mockedStripePaymentIntentId);
    });
  });

  describe("succeeded: replays the capture", () => {
    it("answers CHARGE_SUCCESS with amount_received under the PaymentIntent id, with no Stripe write", async () => {
      liveStatus(capturedPaymentIntent(60_00));
      const capture = captureAnswers(alreadyCapturedError());

      const result = await execute(chargeEvent(100));

      expect(capture).not.toHaveBeenCalled();
      expect(result._unsafeUnwrap()).toBeInstanceOf(
        TransactionChargeRequestedUseCaseResponses.Success,
      );
      expect(await answerOf(result)).toMatchObject({
        result: "CHARGE_SUCCESS",
        amount: 60,
        pspReference: mockedStripePaymentIntentId,
      });
    });
  });

  describe("canceled: the authorization is gone", () => {
    it("answers CHARGE_FAILURE 'authorization released or expired' under a unique pspReference, with no Stripe write", async () => {
      liveStatus(paymentIntent({ status: "canceled", amount_capturable: 0 }));
      const capture = captureAnswers();

      const result = await execute(chargeEvent(100));

      expect(capture).not.toHaveBeenCalled();

      const failure = result._unsafeUnwrap();

      expect(failure).toBeInstanceOf(TransactionChargeRequestedUseCaseResponses.Failure);
      expect(failure.transactionResult).toBeInstanceOf(ChargeFailureResult);

      const answer = await answerOf(result);

      expect(answer.result).toBe("CHARGE_FAILURE");
      expect(answer.message).toContain("authorization released or expired");
      expect(answer.pspReference).toMatch(/^charge-failure-/);
      /*
       * Review P2: only CANCEL, so staff keep the Dashboard's Cancel. Saleor still counts the
       * authorization; the cancel handler then replays CANCEL_SUCCESS, which clears it.
       */
      expect(answer.actions).toStrictEqual(["CANCEL"]);
    });
  });

  describe("other statuses", () => {
    it("asks Saleor to retry (HTTP 503) while the PaymentIntent is processing", async () => {
      liveStatus(paymentIntent({ status: "processing", amount_capturable: 0 }));
      const capture = captureAnswers();

      const result = await execute(chargeEvent(100));

      expect(capture).not.toHaveBeenCalled();
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(ChargeOutcomeUnknownResponse);
      expect(result._unsafeUnwrapErr().getResponse().status).toBe(503);
    });

    it.each(["requires_payment_method", "requires_confirmation", "requires_action"] as const)(
      "answers CHARGE_FAILURE under a unique pspReference, with no Stripe write, when the PaymentIntent is %s",
      async (status) => {
        liveStatus(paymentIntent({ status, amount_capturable: 0 }));
        const capture = captureAnswers();

        const result = await execute(chargeEvent(100));

        expect(capture).not.toHaveBeenCalled();
        expect(result._unsafeUnwrap()).toBeInstanceOf(
          TransactionChargeRequestedUseCaseResponses.Failure,
        );
        expect((await answerOf(result)).pspReference).toMatch(/^charge-failure-/);
      },
    );
  });

  describe("an outcome Stripe did not report: HTTP 503, Saleor re-sends the same request", () => {
    const unknownOutcomes = [
      {
        case: "a network failure or timeout (StripeConnectionError)",
        error: () =>
          new Stripe.errors.StripeConnectionError({
            message: "Request aborted due to timeout being reached (5000ms)",
          } as Stripe.StripeRawError),
      },
      {
        case: "a Stripe server error (StripeAPIError)",
        error: () =>
          new Stripe.errors.StripeAPIError({
            type: "api_error",
            message: "Something went wrong on Stripe's end.",
            statusCode: 500,
          }),
      },
      {
        case: "any Stripe error with a 5xx status",
        error: () =>
          new Stripe.errors.StripeInvalidRequestError({
            type: "invalid_request_error",
            message: "Service unavailable",
            statusCode: 503,
          }),
      },
      {
        case: "the same key still in progress at Stripe (409 idempotency_key_in_use)",
        error: () =>
          new Stripe.errors.StripeInvalidRequestError({
            type: "invalid_request_error",
            code: "idempotency_key_in_use",
            message: "There is currently another in-progress request using this idempotency key.",
            statusCode: 409,
          }),
      },
    ];

    it.each(unknownOutcomes)("on the capture: $case", async ({ error }) => {
      liveStatus(paymentIntent());
      captureAnswers(error());

      const result = await execute(chargeEvent(100));

      const response = result._unsafeUnwrapErr();

      expect(response).toBeInstanceOf(ChargeOutcomeUnknownResponse);

      const httpResponse = response.getResponse();

      expect(httpResponse.status).toBe(503);
      expect(await httpResponse.json()).not.toHaveProperty("result");
    });

    it.each(unknownOutcomes)("on the live read, with no capture: $case", async ({ error }) => {
      vi.spyOn(
        mockedStripePaymentIntentsApi,
        "getPaymentIntentForTransactionAction",
      ).mockImplementationOnce(async () => err(error()));
      const capture = captureAnswers();

      const result = await execute(chargeEvent(100));

      expect(capture).not.toHaveBeenCalled();
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(ChargeOutcomeUnknownResponse);
    });

    it("when the capture answers a PaymentIntent that is not succeeded yet", async () => {
      liveStatus(paymentIntent());
      captureAnswers(paymentIntent({ status: "processing", amount_capturable: 0 }));

      const result = await execute(chargeEvent(100));

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(ChargeOutcomeUnknownResponse);
    });

    it("Saleor's retry reads the PaymentIntent again and replays the capture the first attempt made", async () => {
      liveStatus(paymentIntent(), capturedPaymentIntent(100_00));
      const capture = captureAnswers(
        new Stripe.errors.StripeConnectionError({
          message: "An error occurred with our connection to Stripe.",
        } as Stripe.StripeRawError),
      );

      const first = await execute(chargeEvent(100));
      const retry = await execute(chargeEvent(100));

      expect(first._unsafeUnwrapErr()).toBeInstanceOf(ChargeOutcomeUnknownResponse);
      expect(capture).toHaveBeenCalledOnce();
      expect(await answerOf(retry)).toMatchObject({
        result: "CHARGE_SUCCESS",
        amount: 100,
        pspReference: mockedStripePaymentIntentId,
      });
    });
  });

  describe("a definite Stripe error: CHARGE_FAILURE under a unique pspReference", () => {
    it.each([
      { case: "a capture refused by Stripe (unexpected state)", error: alreadyCapturedError },
      {
        case: "a rate limit",
        error: () =>
          new Stripe.errors.StripeRateLimitError({
            type: "rate_limit_error",
            message: "Too many requests",
            statusCode: 429,
          }),
      },
    ])("on the capture: $case", async ({ error }) => {
      liveStatus(paymentIntent());
      captureAnswers(error());

      const result = await execute(chargeEvent(100));

      expect(result._unsafeUnwrap()).toBeInstanceOf(
        TransactionChargeRequestedUseCaseResponses.Failure,
      );

      const answer = await answerOf(result);

      expect(answer.result).toBe("CHARGE_FAILURE");
      expect(answer.pspReference).toMatch(/^charge-failure-/);
    });

    it("on the live read (e.g. unknown PaymentIntent), with no capture", async () => {
      vi.spyOn(
        mockedStripePaymentIntentsApi,
        "getPaymentIntentForTransactionAction",
      ).mockImplementationOnce(async () =>
        err(
          new Stripe.errors.StripeInvalidRequestError({
            type: "invalid_request_error",
            code: "resource_missing",
            message: "No such payment_intent",
            statusCode: 404,
          }),
        ),
      );
      const capture = captureAnswers();

      const result = await execute(chargeEvent(100));

      expect(capture).not.toHaveBeenCalled();
      expect((await answerOf(result)).pspReference).toMatch(/^charge-failure-/);
    });
  });

  /*
   * Regression (live bug, 2026-10-22). Saleor 3.22.74 groups transaction events by pspReference
   * and drops a CHARGE_SUCCESS when a newer CHARGE_FAILURE has the same pspReference
   * (payment/transaction_item_calculations.py _should_increse_amount). The old handler captured
   * again and answered Stripe's "already captured" as CHARGE_FAILURE under the PaymentIntent id,
   * so a second capture request (double click, app/staff race, retry) took chargedAmount back to 0.
   */
  describe("regression: a repeated capture never cancels the recorded capture", () => {
    it("a second charge request on a succeeded PaymentIntent never produces a FAILURE event", async () => {
      liveStatus(paymentIntent(), capturedPaymentIntent(100_00));
      const capture = captureAnswers(capturedPaymentIntent(100_00), alreadyCapturedError());

      const first = await execute(chargeEvent(100));
      const second = await execute(chargeEvent(100));

      expect(capture).toHaveBeenCalledOnce();
      expect(second._unsafeUnwrap()).toBeInstanceOf(
        TransactionChargeRequestedUseCaseResponses.Success,
      );

      const firstAnswer = await answerOf(first);
      const secondAnswer = await answerOf(second);

      expect(secondAnswer.result).toBe("CHARGE_SUCCESS");
      // Same (pspReference, type, amount): Saleor keeps its first event (payment/utils.py deduplicate_event).
      expect(secondAnswer.pspReference).toBe(firstAnswer.pspReference);
      expect(secondAnswer.amount).toBe(firstAnswer.amount);
    });

    it("a capture Stripe refuses in a race (both requests saw requires_capture) is never answered under the PaymentIntent id", async () => {
      liveStatus(paymentIntent());
      captureAnswers(alreadyCapturedError());

      const result = await execute(chargeEvent(100));

      const answer = await answerOf(result);

      expect(answer.result).toBe("CHARGE_FAILURE");
      expect(answer.pspReference).not.toBe(mockedStripePaymentIntentId);
    });
  });

  it("Returns 'MissingConfigErrorResponse' if config not found for specified channel", async () => {
    const spy = vi
      .spyOn(mockedAppConfigRepo, "getStripeConfig")
      .mockImplementationOnce(async () => ok(null));

    const responsePayload = await execute(getMockedTransactionChargeRequestedEvent());

    const err = responsePayload._unsafeUnwrapErr();

    expect(spy).toHaveBeenCalledOnce();

    expect(err).toBeInstanceOf(AppIsNotConfiguredResponse);
  });

  it("Returns 'BrokenAppResponse' when currency coming from Stripe is not supported", async () => {
    liveStatus(paymentIntent({ currency: "abc", status: "succeeded", amount_received: 100 }));

    const response = await execute(getMockedTransactionChargeRequestedEvent());

    expect(response._unsafeUnwrapErr()).toBeInstanceOf(BrokenAppResponse);
  });

  it("Throws error when Saleor event has no transaction", async () => {
    const saleorEvent = { ...getMockedTransactionChargeRequestedEvent(), transaction: null };

    await expect(execute(saleorEvent)).rejects.toThrowErrorMatchingInlineSnapshot(
      `[MissingTransactionError: Transaction not found in event]`,
    );
  });

  it("Throws error when Saleor event has no channel for Saleor Checkout or Order", async () => {
    const saleorEvent = {
      ...getMockedTransactionChargeRequestedEvent(),
      transaction: {
        checkout: null,
        order: null,
        pspReference: mockedStripePaymentIntentId,
        id: mockedSaleorTransactionId,
      },
    };

    await expect(execute(saleorEvent)).rejects.toThrowErrorMatchingInlineSnapshot(
      `[MissingChannelIdError: Channel ID not found in event Checkout or Order]`,
    );
  });
});
