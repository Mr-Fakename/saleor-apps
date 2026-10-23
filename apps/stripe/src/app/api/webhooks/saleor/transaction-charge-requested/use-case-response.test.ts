import { describe, expect, it } from "vitest";

import { getMockedSaleorMoney } from "@/__tests__/mocks/constants";
import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { parseTransactionActionAnswer } from "@/__tests__/transaction-action-answer";
import { StripeAPIError } from "@/modules/stripe/stripe-api-error";
import { ChargeFailureResult } from "@/modules/transaction-result/failure-result";
import { ChargeSuccessResult } from "@/modules/transaction-result/success-result";

import { ChargeAuthorizationReleasedError } from "./charge-refusal-errors";
import {
  ChargeOutcomeUnknownResponse,
  TransactionChargeRequestedUseCaseResponses,
} from "./use-case-response";

describe("TransactionChargeRequestedUseCaseResponses", () => {
  describe("Success with ChargeSuccessResult", () => {
    it("getResponse() returns valid Response with status 200", async () => {
      const successResponse = new TransactionChargeRequestedUseCaseResponses.Success({
        transactionResult: new ChargeSuccessResult(),
        stripePaymentIntentId: mockedStripePaymentIntentId,
        saleorMoney: getMockedSaleorMoney(),
        appContext: {
          stripeEnv: "LIVE",
        },
      });
      const fetchReponse = successResponse.getResponse();

      expect(fetchReponse.status).toBe(200);
      expect(await fetchReponse.json()).toMatchInlineSnapshot(`
        {
          "actions": [
            "REFUND",
          ],
          "amount": 10,
          "externalUrl": "https://dashboard.stripe.com/payments/pi_TEST_TEST_TEST",
          "message": "Payment intent has been successful",
          "pspReference": "pi_TEST_TEST_TEST",
          "result": "CHARGE_SUCCESS",
        }
      `);
    });
  });

  describe("Failure with ChargeFailureResult", () => {
    const failure = (
      args: Partial<
        ConstructorParameters<typeof TransactionChargeRequestedUseCaseResponses.Failure>[0]
      > = {},
    ) =>
      new TransactionChargeRequestedUseCaseResponses.Failure({
        transactionResult: new ChargeFailureResult(),
        stripePaymentIntentId: mockedStripePaymentIntentId,
        error: new StripeAPIError("Error from stripe"),
        actions: null,
        appContext: {
          stripeEnv: "LIVE",
        },
        ...args,
      });

    /*
     * Saleor 3.22.74 drops a CHARGE_SUCCESS when a newer CHARGE_FAILURE has the same
     * pspReference (payment/transaction_item_calculations.py _should_increse_amount), and keeps
     * the first of two events with the same pspReference and type (payment/utils.py
     * deduplicate_event). Under the PaymentIntent id a failure cancelled the recorded capture.
     */
    it("answers CHARGE_FAILURE under a pspReference of its own, never the PaymentIntent id", async () => {
      const fetchReponse = failure().getResponse();

      expect(fetchReponse.status).toBe(200);
      expect(await fetchReponse.json()).toStrictEqual({
        externalUrl: "https://dashboard.stripe.com/payments/pi_TEST_TEST_TEST",
        message: "Payment intent failed",
        pspReference: expect.stringMatching(/^charge-failure-[0-9a-f-]{36}$/),
        result: "CHARGE_FAILURE",
      });
    });

    it("gives every failure another pspReference", async () => {
      const first = parseTransactionActionAnswer(await failure().getResponse().json());
      const second = parseTransactionActionAnswer(await failure().getResponse().json());

      expect(first.pspReference).not.toBe(second.pspReference);
    });

    it("leaves Saleor's available actions as they are when no actions are given", async () => {
      expect(await failure({ actions: null }).getResponse().json()).not.toHaveProperty("actions");
    });

    it("sends the given actions", async () => {
      expect(await failure({ actions: [] }).getResponse().json()).toMatchObject({ actions: [] });
    });

    it("tells staff why the app refused the capture", async () => {
      const body = parseTransactionActionAnswer(
        await failure({
          error: new ChargeAuthorizationReleasedError("PaymentIntent is canceled"),
          actions: ["CANCEL"],
        })
          .getResponse()
          .json(),
      );

      expect(body.message).toContain("authorization released or expired");
    });
  });

  describe("ChargeOutcomeUnknownResponse", () => {
    it("answers HTTP 503 with no result, so Saleor re-sends the same request", async () => {
      const response = new ChargeOutcomeUnknownResponse(
        { stripeEnv: "LIVE" },
        new StripeAPIError("Error from stripe"),
      ).getResponse();

      expect(response.status).toBe(503);
      expect(await response.json()).not.toHaveProperty("result");
    });
  });
});
