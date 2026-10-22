import { describe, expect, it } from "vitest";

import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { mockedStripeRefundId } from "@/__tests__/mocks/mocked-stripe-refund-id";
import { StripeAPIError } from "@/modules/stripe/stripe-api-error";
import { RefundFailureResult } from "@/modules/transaction-result/refund-result";

import { RefundAlreadyRecordedError, RefundRequestChangedError } from "./refund-refusal-errors";
import { TransactionRefundRequestedUseCaseResponses } from "./use-case-response";

describe("TransactionRefundRequestedUseCaseResponses", () => {
  describe("Success", () => {
    it("getResponse() returns valid Response with status 200", async () => {
      const response = new TransactionRefundRequestedUseCaseResponses.Success({
        stripeRefundId: mockedStripeRefundId,
        stripePaymentIntentId: mockedStripePaymentIntentId,
        appContext: {
          stripeEnv: "LIVE",
        },
      });
      const fetchReponse = response.getResponse();

      expect(fetchReponse.status).toBe(200);
      expect(await fetchReponse.json()).toMatchInlineSnapshot(`
        {
          "pspReference": "pi_TEST_TEST_TEST",
        }
      `);
    });
  });

  describe("Failure", () => {
    it("getResponse() returns valid Response with status 200", async () => {
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
      expect(await fetchReponse.json()).toMatchInlineSnapshot(`
        {
          "actions": [
            "REFUND",
          ],
          "externalUrl": "https://dashboard.stripe.com/payments/pi_TEST_TEST_TEST",
          "message": "There is a problem with the request to Stripe API",
          "pspReference": "pi_TEST_TEST_TEST",
          "result": "REFUND_FAILURE",
        }
      `);
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
      "tells staff why the app refused the refund, without pspReference ($error.name)",
      async ({ error, expected }) => {
        const response = new TransactionRefundRequestedUseCaseResponses.Failure({
          transactionResult: new RefundFailureResult(),
          stripePaymentIntentId: mockedStripePaymentIntentId,
          error,
          appContext: {
            stripeEnv: "LIVE",
          },
        });

        const body = await response.getResponse().json();

        /*
         * Review round 3 (P1): a refusal under the PaymentIntent's pspReference is a newer
         * REFUND_FAILURE of that reference, and Saleor then drops the PaymentIntent's earlier
         * REFUND_SUCCESS from refundedAmount. No pspReference: Saleor counts it nowhere.
         */
        expect(body).toStrictEqual({
          actions: ["REFUND"],
          externalUrl: "https://dashboard.stripe.com/payments/pi_TEST_TEST_TEST",
          message: expect.stringContaining(expected),
          result: "REFUND_FAILURE",
        });
        expect(body).not.toHaveProperty("pspReference");
      },
    );
  });
});
