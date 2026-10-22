import { describe, expect, it } from "vitest";

import { ChargeFailureResult } from "@/modules/transaction-result/failure-result";

import {
  PaymentFeePresentError,
  PaymentFeeRequiredError,
  PaymentFeeStaleError,
  PaymentMethodNotAllowedErrorPublicCode,
} from "./payment-method-errors";
import { TransactionInitializeSessionUseCaseResponses } from "./use-case-response";

/*
 * A3c §1d: the refusal public code the storefront maps to localized text
 * (storefront stripeAmount.ts parseInitializeRefusal).
 */
describe("TransactionInitializeSessionUseCaseResponses.Failure: PaymentMethodNotAllowedError", () => {
  it("uses the public code PaymentMethodNotAllowedError", () => {
    expect(PaymentMethodNotAllowedErrorPublicCode).toBe("PaymentMethodNotAllowedError");
  });

  it.each([
    {
      error: new PaymentFeeRequiredError("no fee line"),
      message: "PayPal needs the PayPal fee on the checkout. Apply the fee, then try again.",
    },
    {
      error: new PaymentFeeStaleError("fee line out of date"),
      message: "The PayPal fee on the checkout is out of date. Apply the fee again, then try again.",
    },
    {
      error: new PaymentFeePresentError("fee line with card"),
      message: "The checkout holds a PayPal fee. Remove the fee or choose PayPal.",
    },
  ])("answers $error.name with the code and its own message", async ({ error, message }) => {
    const response = new TransactionInitializeSessionUseCaseResponses.Failure({
      transactionResult: new ChargeFailureResult(),
      error,
      appContext: { stripeEnv: "LIVE" },
    });

    const fetchResponse = response.getResponse();

    expect(fetchResponse.status).toBe(200);
    expect(await fetchResponse.json()).toStrictEqual({
      actions: ["CHARGE"],
      data: {
        paymentIntent: {
          errors: [{ code: "PaymentMethodNotAllowedError", message }],
        },
      },
      message: "Payment intent failed",
      result: "CHARGE_FAILURE",
    });
  });
});
