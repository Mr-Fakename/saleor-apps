import { err, ok } from "neverthrow";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockedSaleorAppId, mockedSaleorTransactionId } from "@/__tests__/mocks/constants";
import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { mockedStripePaymentIntentsApi } from "@/__tests__/mocks/mocked-stripe-payment-intents-api";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { getMockedTransactionCancelationRequestedEvent } from "@/__tests__/mocks/saleor-events/transaction-cancelation-request-event";
import { parseTransactionActionAnswer } from "@/__tests__/transaction-action-answer";
import {
  AppIsNotConfiguredResponse,
  BrokenAppResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import { TransactionCancelationRequestedEventFragment } from "@/generated/graphql";
import { appContextContainer } from "@/lib/app-context";
import { IStripePaymentIntentsApiFactory } from "@/modules/stripe/types";
import {
  CancelFailureResult,
  CancelSuccessResult,
} from "@/modules/transaction-result/cancel-result";

import { TransactionCancelationRequestedUseCase } from "./use-case";
import {
  CancelOutcomeUnknownResponse,
  TransactionCancelationRequestedUseCaseResponses,
} from "./use-case-response";

const CANCELED_AT = 1_761_000_000;

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

const canceledPaymentIntent = () =>
  paymentIntent({ status: "canceled", amount_capturable: 0, canceled_at: CANCELED_AT });

/** Stripe's answer to a cancel of a PaymentIntent that is already canceled or succeeded. */
const unexpectedStateError = () =>
  new Stripe.errors.StripeInvalidRequestError({
    type: "invalid_request_error",
    code: "payment_intent_unexpected_state",
    message: "You cannot cancel this PaymentIntent because it has a status of canceled.",
    statusCode: 400,
  });

describe("TransactionCancelationRequestedUseCase", () => {
  // getResponse() needs the Stripe environment that the route sets for each request.
  beforeEach(() => {
    vi.spyOn(appContextContainer, "getContextValue").mockReturnValue({ stripeEnv: "LIVE" });
  });

  const stripePaymentIntentsApiFactory = {
    create: () => mockedStripePaymentIntentsApi,
  } satisfies IStripePaymentIntentsApiFactory;

  const execute = (
    event: TransactionCancelationRequestedEventFragment = getMockedTransactionCancelationRequestedEvent(),
  ) =>
    new TransactionCancelationRequestedUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripePaymentIntentsApiFactory,
    }).execute({ saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId, event });

  const liveStatus = (...answers: Stripe.PaymentIntent[]) => {
    const spy = vi.spyOn(mockedStripePaymentIntentsApi, "getPaymentIntentForTransactionAction");

    answers.forEach((answer) => spy.mockImplementationOnce(async () => ok(answer)));

    return spy;
  };

  const cancelAnswers = (...answers: Array<Stripe.PaymentIntent | Error>) => {
    const spy = vi.spyOn(mockedStripePaymentIntentsApi, "cancelPaymentIntentForTransactionAction");

    answers.forEach((answer) =>
      spy.mockImplementationOnce(async () => (answer instanceof Error ? err(answer) : ok(answer))),
    );

    return spy;
  };

  /** The JSON Saleor receives for a sync answer; the result must be Ok. */
  const answerOf = async (result: Awaited<ReturnType<typeof execute>>) =>
    parseTransactionActionAnswer(await result._unsafeUnwrap().getResponse().json());

  it("reads the live PaymentIntent, then cancels it with the key cancel:v1:<pi>:<live status>", async () => {
    const read = liveStatus(paymentIntent());
    const cancel = cancelAnswers(canceledPaymentIntent());

    const result = await execute();

    expect(read).toHaveBeenCalledExactlyOnceWith({ id: mockedStripePaymentIntentId });
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(cancel.mock.invocationCallOrder[0]);
    expect(cancel).toHaveBeenCalledExactlyOnceWith({
      id: mockedStripePaymentIntentId,
      idempotencyKey: "cancel:v1:pi_TEST_TEST_TEST:requires_capture",
    });

    const success = result._unsafeUnwrap();

    expect(success).toBeInstanceOf(TransactionCancelationRequestedUseCaseResponses.Success);
    expect(success.transactionResult).toBeInstanceOf(CancelSuccessResult);
    expect(await answerOf(result)).toMatchObject({
      result: "CANCEL_SUCCESS",
      amount: 100,
      pspReference: mockedStripePaymentIntentId,
    });
  });

  it("canceled: replays CANCEL_SUCCESS under the PaymentIntent id, with no Stripe write", async () => {
    liveStatus(canceledPaymentIntent());
    const cancel = cancelAnswers(unexpectedStateError());

    const result = await execute();

    expect(cancel).not.toHaveBeenCalled();
    expect(await answerOf(result)).toMatchObject({
      result: "CANCEL_SUCCESS",
      amount: 100,
      pspReference: mockedStripePaymentIntentId,
      time: new Date(CANCELED_AT * 1000).toISOString(),
    });
  });

  it("succeeded: answers CANCEL_FAILURE 'already captured: refund instead' under a unique pspReference, with no Stripe write", async () => {
    liveStatus(
      paymentIntent({ status: "succeeded", amount_capturable: 0, amount_received: 100_00 }),
    );
    const cancel = cancelAnswers();

    const result = await execute();

    expect(cancel).not.toHaveBeenCalled();

    const failure = result._unsafeUnwrap();

    expect(failure).toBeInstanceOf(TransactionCancelationRequestedUseCaseResponses.Failure);
    expect(failure.transactionResult).toBeInstanceOf(CancelFailureResult);

    const answer = await answerOf(result);

    expect(answer.result).toBe("CANCEL_FAILURE");
    expect(answer.message).toContain("already captured: refund instead");
    expect(answer.pspReference).toMatch(/^cancel-failure-/);
    expect(answer.actions).toStrictEqual(["REFUND"]);
  });

  it.each(["requires_payment_method", "requires_confirmation", "requires_action"] as const)(
    "%s: asks Stripe to cancel, with the idempotency key of that status",
    async (status) => {
      liveStatus(paymentIntent({ status, amount_capturable: 0 }));
      const cancel = cancelAnswers(canceledPaymentIntent());

      const result = await execute();

      expect(cancel).toHaveBeenCalledExactlyOnceWith({
        id: mockedStripePaymentIntentId,
        idempotencyKey: `cancel:v1:pi_TEST_TEST_TEST:${status}`,
      });
      expect(result._unsafeUnwrap()).toBeInstanceOf(
        TransactionCancelationRequestedUseCaseResponses.Success,
      );
    },
  );

  /*
   * Review P2: Stripe refuses to cancel a processing PaymentIntent in most cases, and it stores a
   * refusal under the idempotency key and replays it for at least 24 h. No write: Saleor retries.
   */
  it("processing: asks Saleor to retry (HTTP 503), with no Stripe write", async () => {
    liveStatus(paymentIntent({ status: "processing", amount_capturable: 0 }));
    const cancel = cancelAnswers(unexpectedStateError());

    const result = await execute();

    expect(cancel).not.toHaveBeenCalled();
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(CancelOutcomeUnknownResponse);
    expect(result._unsafeUnwrapErr().getResponse().status).toBe(503);
  });

  /*
   * Review P2: Stripe stores the result of a request under its idempotency key, a refusal
   * included, and replays it for at least 24 h. A refused cancel must not block a later, valid
   * cancel of the same PaymentIntent while a hold stays on the shopper's card.
   */
  describe("a refused cancel is never replayed to a later cancel", () => {
    /** Stripe's idempotency: the first result for a key is returned again for that key. */
    const stripeWithIdempotency = (outcomes: Array<Stripe.PaymentIntent | Error>) => {
      const stored = new Map<string, Stripe.PaymentIntent | Error>();

      return vi
        .spyOn(mockedStripePaymentIntentsApi, "cancelPaymentIntentForTransactionAction")
        .mockImplementation(async ({ idempotencyKey }) => {
          const outcome = stored.get(idempotencyKey) ?? outcomes.shift();

          if (outcome === undefined) {
            throw new Error("No Stripe outcome left in the test");
          }

          stored.set(idempotencyKey, outcome);

          return outcome instanceof Error ? err(outcome) : ok(outcome);
        });
    };

    it("a cancel Stripe refuses (the status changed after the read) answers CANCEL_FAILURE under a unique pspReference, and the next cancel from requires_capture is carried out", async () => {
      // 1st request: read requires_action, then the shopper confirms; Stripe refuses the cancel.
      liveStatus(
        paymentIntent({ status: "requires_action", amount_capturable: 0 }),
        paymentIntent(),
      );
      const cancel = stripeWithIdempotency([unexpectedStateError(), canceledPaymentIntent()]);

      const refused = await answerOf(await execute());

      expect(refused.result).toBe("CANCEL_FAILURE");
      expect(refused.pspReference).toMatch(/^cancel-failure-/);

      // 2nd request (staff, or the release of an expired checkout): the PaymentIntent holds funds.
      const released = await answerOf(await execute());

      expect(cancel).toHaveBeenCalledTimes(2);
      expect(cancel.mock.calls[1][0].idempotencyKey).not.toBe(
        cancel.mock.calls[0][0].idempotencyKey,
      );
      expect(released).toMatchObject({
        result: "CANCEL_SUCCESS",
        pspReference: mockedStripePaymentIntentId,
      });
    });
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

    it.each(unknownOutcomes)("on the cancel: $case", async ({ error }) => {
      liveStatus(paymentIntent());
      cancelAnswers(error());

      const result = await execute();

      const response = result._unsafeUnwrapErr();

      expect(response).toBeInstanceOf(CancelOutcomeUnknownResponse);

      const httpResponse = response.getResponse();

      expect(httpResponse.status).toBe(503);
      expect(await httpResponse.json()).not.toHaveProperty("result");
    });

    it.each(unknownOutcomes)("on the live read, with no cancel: $case", async ({ error }) => {
      vi.spyOn(
        mockedStripePaymentIntentsApi,
        "getPaymentIntentForTransactionAction",
      ).mockImplementationOnce(async () => err(error()));
      const cancel = cancelAnswers();

      const result = await execute();

      expect(cancel).not.toHaveBeenCalled();
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(CancelOutcomeUnknownResponse);
    });

    it("when the cancel answers a PaymentIntent that is not canceled", async () => {
      liveStatus(paymentIntent());
      cancelAnswers(paymentIntent({ status: "processing", amount_capturable: 0 }));

      const result = await execute();

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(CancelOutcomeUnknownResponse);
    });

    it("Saleor's retry reads the PaymentIntent again and replays the cancel the first attempt made", async () => {
      liveStatus(paymentIntent(), canceledPaymentIntent());
      const cancel = cancelAnswers(
        new Stripe.errors.StripeConnectionError({
          message: "An error occurred with our connection to Stripe.",
        } as Stripe.StripeRawError),
      );

      const first = await execute();
      const retry = await execute();

      expect(first._unsafeUnwrapErr()).toBeInstanceOf(CancelOutcomeUnknownResponse);
      expect(cancel).toHaveBeenCalledOnce();
      expect(await answerOf(retry)).toMatchObject({
        result: "CANCEL_SUCCESS",
        pspReference: mockedStripePaymentIntentId,
      });
    });
  });

  it("a definite Stripe error: CANCEL_FAILURE under a unique pspReference", async () => {
    liveStatus(paymentIntent());
    cancelAnswers(unexpectedStateError());

    const result = await execute();

    expect(result._unsafeUnwrap()).toBeInstanceOf(
      TransactionCancelationRequestedUseCaseResponses.Failure,
    );

    const answer = await answerOf(result);

    expect(answer.result).toBe("CANCEL_FAILURE");
    expect(answer.pspReference).toMatch(/^cancel-failure-/);
  });

  /*
   * Regression (live bug, 2026-10-22). Saleor 3.22.74 drops a CANCEL_SUCCESS when a newer
   * CANCEL_FAILURE has the same pspReference (payment/transaction_item_calculations.py
   * _recalculate_cancel_amounts, _should_increse_amount): the authorization came back. The old
   * handler cancelled again and answered Stripe's refusal under the PaymentIntent id.
   */
  describe("regression: a repeated cancel never cancels the recorded cancel", () => {
    it("a second cancel request on a canceled PaymentIntent never produces a FAILURE event", async () => {
      liveStatus(paymentIntent(), canceledPaymentIntent());
      const cancel = cancelAnswers(canceledPaymentIntent(), unexpectedStateError());

      const first = await execute();
      const second = await execute();

      expect(cancel).toHaveBeenCalledOnce();
      expect(second._unsafeUnwrap()).toBeInstanceOf(
        TransactionCancelationRequestedUseCaseResponses.Success,
      );

      const firstAnswer = await answerOf(first);
      const secondAnswer = await answerOf(second);

      expect(secondAnswer.result).toBe("CANCEL_SUCCESS");
      // Same (pspReference, type, amount): Saleor keeps its first event (payment/utils.py deduplicate_event).
      expect(secondAnswer.pspReference).toBe(firstAnswer.pspReference);
      expect(secondAnswer.amount).toBe(firstAnswer.amount);
    });

    it("a cancel Stripe refuses in a race (both requests saw requires_capture) is never answered under the PaymentIntent id", async () => {
      liveStatus(paymentIntent());
      cancelAnswers(unexpectedStateError());

      const answer = await answerOf(await execute());

      expect(answer.result).toBe("CANCEL_FAILURE");
      expect(answer.pspReference).not.toBe(mockedStripePaymentIntentId);
    });
  });

  it("Returns 'MissingConfigErrorResponse' if config not found for specified channel", async () => {
    const spy = vi
      .spyOn(mockedAppConfigRepo, "getStripeConfig")
      .mockImplementationOnce(async () => ok(null));

    const responsePayload = await execute();

    const err = responsePayload._unsafeUnwrapErr();

    expect(spy).toHaveBeenCalledOnce();

    expect(err).toBeInstanceOf(AppIsNotConfiguredResponse);
  });

  it("Returns 'BrokenAppResponse' when currency coming from Stripe is not supported", async () => {
    liveStatus(paymentIntent({ currency: "abc", status: "canceled", canceled_at: CANCELED_AT }));

    const response = await execute();

    expect(response._unsafeUnwrapErr()).toBeInstanceOf(BrokenAppResponse);
  });

  it("Throws error when Saleor event has no transaction", async () => {
    const saleorEvent = { ...getMockedTransactionCancelationRequestedEvent(), transaction: null };

    await expect(execute(saleorEvent)).rejects.toThrowErrorMatchingInlineSnapshot(
      `[MissingTransactionError: Transaction not found in event]`,
    );
  });

  it("Throws error when Saleor event has no channel for Saleor Checkout or Order", async () => {
    const saleorEvent = {
      ...getMockedTransactionCancelationRequestedEvent(),
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
