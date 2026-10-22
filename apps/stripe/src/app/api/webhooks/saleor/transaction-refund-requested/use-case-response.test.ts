import { describe, expect, it } from "vitest";

import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { mockedStripeRefundId } from "@/__tests__/mocks/mocked-stripe-refund-id";
import { StripeAPIError, StripeConnectionError } from "@/modules/stripe/stripe-api-error";
import { RefundFailureResult } from "@/modules/transaction-result/refund-result";

import { RefundAlreadyRecordedError, RefundRequestChangedError } from "./refund-refusal-errors";
import {
  RefundOutcomeUnknownResponse,
  TransactionRefundRequestedUseCaseResponses,
} from "./use-case-response";

/** createRefundFailurePspReference: unique, never a PaymentIntent or a Stripe refund id. */
const UNIQUE_FAILURE_REFERENCE = /^refund-failure-[0-9a-f-]{36}$/;

/** The JSON body Saleor receives from the app. */
type SaleorAnswer = {
  pspReference?: string;
  result?: string;
  message?: string;
  externalUrl?: string;
  actions?: string[];
};

const saleorAnswer = async (response: Response) => (await response.json()) as SaleorAnswer;

describe("TransactionRefundRequestedUseCaseResponses", () => {
  describe("Success", () => {
    it("getResponse() answers Saleor (async flow) with the Stripe refund id as pspReference (A2e)", async () => {
      const response = new TransactionRefundRequestedUseCaseResponses.Success({
        stripeRefundId: mockedStripeRefundId,
        stripePaymentIntentId: mockedStripePaymentIntentId,
        pspReference: mockedStripeRefundId,
        appContext: {
          stripeEnv: "LIVE",
        },
      });
      const fetchReponse = response.getResponse();

      expect(fetchReponse.status).toBe(200);
      expect(await fetchReponse.json()).toMatchInlineSnapshot(`
        {
          "pspReference": "re_TEST_TEST_TEST",
        }
      `);
    });

    it("answers with the PaymentIntent when the use case chose it for a refund recorded under it before A2e", async () => {
      const response = new TransactionRefundRequestedUseCaseResponses.Success({
        stripeRefundId: mockedStripeRefundId,
        stripePaymentIntentId: mockedStripePaymentIntentId,
        pspReference: mockedStripePaymentIntentId,
        appContext: {
          stripeEnv: "LIVE",
        },
      });

      expect(await response.getResponse().json()).toStrictEqual({
        pspReference: "pi_TEST_TEST_TEST",
      });
    });
  });

  describe("Failure", () => {
    it("getResponse() returns status 200 with REFUND_FAILURE under a unique pspReference that is not the PaymentIntent (A2e)", async () => {
      const response = new TransactionRefundRequestedUseCaseResponses.Failure({
        transactionResult: new RefundFailureResult(),
        stripePaymentIntentId: mockedStripePaymentIntentId,
        error: new StripeAPIError("Error from stripe"),
        appContext: {
          stripeEnv: "LIVE",
        },
      });
      const fetchReponse = response.getResponse();

      expect(fetchReponse.status).toBe(200);

      const body = await saleorAnswer(fetchReponse);

      expect(body).toStrictEqual({
        actions: ["REFUND"],
        externalUrl: "https://dashboard.stripe.com/payments/pi_TEST_TEST_TEST",
        message: "There is a problem with the request to Stripe API",
        pspReference: expect.stringMatching(UNIQUE_FAILURE_REFERENCE),
        result: "REFUND_FAILURE",
      });
      expect(body.pspReference).not.toBe(mockedStripePaymentIntentId);
    });

    /*
     * A2e: Saleor de-duplicates events by (pspReference, type). A failure that repeats an
     * earlier one's pspReference is merged into it, so a retried granted refund kept its
     * REFUND_REQUEST as its newest event and stayed PENDING (retry refused, REFUND_IS_PENDING).
     */
    it("never repeats the pspReference of a failure", async () => {
      const failure = () =>
        new TransactionRefundRequestedUseCaseResponses.Failure({
          transactionResult: new RefundFailureResult(),
          stripePaymentIntentId: mockedStripePaymentIntentId,
          error: new StripeAPIError("Error from stripe"),
          appContext: {
            stripeEnv: "LIVE",
          },
        });

      const first = await saleorAnswer(failure().getResponse());
      const retry = await saleorAnswer(failure().getResponse());

      expect(first.pspReference).toMatch(UNIQUE_FAILURE_REFERENCE);
      expect(retry.pspReference).toMatch(UNIQUE_FAILURE_REFERENCE);
      expect(retry.pspReference).not.toBe(first.pspReference);
    });

    it("keeps one pspReference for one failure, however often its response is read", async () => {
      const response = new TransactionRefundRequestedUseCaseResponses.Failure({
        transactionResult: new RefundFailureResult(),
        stripePaymentIntentId: mockedStripePaymentIntentId,
        error: new StripeAPIError("Error from stripe"),
        appContext: {
          stripeEnv: "LIVE",
        },
      });

      const first = await saleorAnswer(response.getResponse());
      const second = await saleorAnswer(response.getResponse());

      expect(first.pspReference).toBe(response.pspReference);
      expect(second.pspReference).toBe(response.pspReference);
    });

    it.each([
      {
        error: new RefundRequestChangedError("key reused"),
        expected: "amount changed after a possibly-successful attempt; create a new granted refund",
      },
      {
        error: new RefundAlreadyRecordedError("already recorded"),
        expected: "identical refund within 24 h; use a granted refund",
      },
    ])(
      "tells staff why the app refused the refund, under a unique pspReference ($error.name)",
      async ({ error, expected }) => {
        const response = new TransactionRefundRequestedUseCaseResponses.Failure({
          transactionResult: new RefundFailureResult(),
          stripePaymentIntentId: mockedStripePaymentIntentId,
          error,
          appContext: {
            stripeEnv: "LIVE",
          },
        });

        const body = await saleorAnswer(response.getResponse());

        /*
         * Review round 3 (P1): under the PaymentIntent a refusal is a newer REFUND_FAILURE of
         * that reference, and Saleor then drops the PaymentIntent's earlier REFUND_SUCCESS
         * from refundedAmount. A2e: without a pspReference it can match Saleor's own oldest
         * failure without one (e.g. a timeout) and lose this message. A unique reference
         * matches nothing.
         */
        expect(body).toStrictEqual({
          actions: ["REFUND"],
          externalUrl: "https://dashboard.stripe.com/payments/pi_TEST_TEST_TEST",
          message: expect.stringContaining(expected),
          pspReference: expect.stringMatching(UNIQUE_FAILURE_REFERENCE),
          result: "REFUND_FAILURE",
        });
        expect(body.pspReference).not.toBe(mockedStripePaymentIntentId);
        expect(body.pspReference).not.toMatch(/^re_/);
      },
    );
  });

  /*
   * A2e (c): Saleor 3.22.74 re-sends TRANSACTION_REFUND_REQUESTED only when the app answers
   * HTTP >= 500 (handle_transaction_request_task, up to 5 retries), with the same payload,
   * so the refund keeps its idempotency key and Stripe returns the refund it may have made.
   */
  describe("RefundOutcomeUnknownResponse", () => {
    it("answers HTTP 503 and reports no REFUND_FAILURE, so Saleor retries the same request", async () => {
      const response = new RefundOutcomeUnknownResponse(
        { stripeEnv: "LIVE" },
        new StripeConnectionError("There was a network problem between app and Stripe"),
      );
      const fetchResponse = response.getResponse();

      expect(fetchResponse.status).toBe(503);

      const body = await fetchResponse.json();

      expect(body).not.toHaveProperty("result");
      expect(body).not.toHaveProperty("pspReference");
    });
  });
});
