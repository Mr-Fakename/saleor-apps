import { describe, expect, it } from "vitest";

import { getMockedSaleorMoney } from "@/__tests__/mocks/constants";
import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { parseTransactionActionAnswer } from "@/__tests__/transaction-action-answer";
import { StripeAPIError } from "@/modules/stripe/stripe-api-error";
import {
  CancelFailureResult,
  CancelSuccessResult,
} from "@/modules/transaction-result/cancel-result";

import { CancelAlreadyCapturedError } from "./cancel-refusal-errors";
import {
  CancelOutcomeUnknownResponse,
  TransactionCancelationRequestedUseCaseResponses,
} from "./use-case-response";

describe("TransactionCancellationRequestedUseCaseResponses", () => {
  describe("Success", () => {
    it("getResponse() returns valid Response with status 200", async () => {
      const response = new TransactionCancelationRequestedUseCaseResponses.Success({
        saleorMoney: getMockedSaleorMoney(),
        transactionResult: new CancelSuccessResult(),
        stripePaymentIntentId: mockedStripePaymentIntentId,
        timestamp: new Date(2023, 0, 1),
        appContext: {
          stripeEnv: "LIVE",
        },
      });
      const fetchReponse = response.getResponse();

      expect(fetchReponse.status).toBe(200);

      expect(await fetchReponse.json()).toMatchInlineSnapshot(`
        {
          "actions": [],
          "amount": 10,
          "externalUrl": "https://dashboard.stripe.com/payments/pi_TEST_TEST_TEST",
          "message": "Payment intent was cancelled",
          "pspReference": "pi_TEST_TEST_TEST",
          "result": "CANCEL_SUCCESS",
          "time": "2023-01-01T00:00:00.000Z",
        }
      `);
    });
  });

  describe("Failure", () => {
    const failure = (
      args: Partial<
        ConstructorParameters<typeof TransactionCancelationRequestedUseCaseResponses.Failure>[0]
      > = {},
    ) =>
      new TransactionCancelationRequestedUseCaseResponses.Failure({
        transactionResult: new CancelFailureResult(),
        stripePaymentIntentId: mockedStripePaymentIntentId,
        error: new StripeAPIError("Error from stripe"),
        actions: null,
        appContext: {
          stripeEnv: "LIVE",
        },
        ...args,
      });

    /*
     * Saleor 3.22.74 drops a CANCEL_SUCCESS when a newer CANCEL_FAILURE has the same
     * pspReference (payment/transaction_item_calculations.py _recalculate_cancel_amounts).
     * Under the PaymentIntent id a failure brought the released authorization back.
     */
    it("answers CANCEL_FAILURE under a pspReference of its own, never the PaymentIntent id", async () => {
      const fetchReponse = failure().getResponse();

      expect(fetchReponse.status).toBe(200);
      expect(await fetchReponse.json()).toStrictEqual({
        externalUrl: "https://dashboard.stripe.com/payments/pi_TEST_TEST_TEST",
        message: "There is a problem with the request to Stripe API",
        pspReference: expect.stringMatching(/^cancel-failure-[0-9a-f-]{36}$/),
        result: "CANCEL_FAILURE",
      });
    });

    it("gives every failure another pspReference", async () => {
      const first = parseTransactionActionAnswer(await failure().getResponse().json());
      const second = parseTransactionActionAnswer(await failure().getResponse().json());

      expect(first.pspReference).not.toBe(second.pspReference);
    });

    it("tells staff to refund a captured payment, and offers REFUND", async () => {
      const body = parseTransactionActionAnswer(
        await failure({
          error: new CancelAlreadyCapturedError("PaymentIntent is succeeded"),
          actions: ["REFUND"],
        })
          .getResponse()
          .json(),
      );

      expect(body.message).toContain("already captured: refund instead");
      expect(body.actions).toStrictEqual(["REFUND"]);
    });
  });

  describe("CancelOutcomeUnknownResponse", () => {
    it("answers HTTP 503 with no result, so Saleor re-sends the same request", async () => {
      const response = new CancelOutcomeUnknownResponse(
        { stripeEnv: "LIVE" },
        new StripeAPIError("Error from stripe"),
      ).getResponse();

      expect(response.status).toBe(503);
      expect(await response.json()).not.toHaveProperty("result");
    });
  });
});
