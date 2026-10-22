import { BaseError } from "@/lib/errors";

export const PaymentMethodNotAllowedErrorPublicCode = "PaymentMethodNotAllowedError" as const;

/**
 * PayPal-fee gate (A3c §1d, §2b): the shopper's payment-method choice does not match the
 * checkout's PayPal fee line, so the app refuses before any Stripe call. One public code; the
 * storefront maps it to localized text and refetches the checkout (it must not treat it as
 * "another payment pending").
 */
export const PaymentMethodNotAllowedError = BaseError.subclass("PaymentMethodNotAllowedError", {
  props: {
    _internalName: "TransactionInitializeSession.PaymentMethodNotAllowedError" as const,
    publicCode: PaymentMethodNotAllowedErrorPublicCode,
    publicMessage: "This payment method cannot be used for the checkout as it is.",
    merchantMessage:
      "Payment intent not created - the payment method does not match the checkout's PayPal fee",
  },
});

/** PayPal chosen, and the checkout has no fee line (or the source is an order). */
export const PaymentFeeRequiredError = PaymentMethodNotAllowedError.subclass(
  "PaymentFeeRequiredError",
  {
    props: {
      _internalName: "TransactionInitializeSession.PaymentFeeRequiredError" as const,
      publicMessage: "PayPal needs the PayPal fee on the checkout. Apply the fee, then try again.",
      merchantMessage:
        "Payment intent not created - PayPal was chosen but the checkout has no PayPal fee line",
    },
  },
);

/** PayPal chosen, and the fee line is not the fee for this checkout (stale, forged, duplicated). */
export const PaymentFeeStaleError = PaymentMethodNotAllowedError.subclass("PaymentFeeStaleError", {
  props: {
    _internalName: "TransactionInitializeSession.PaymentFeeStaleError" as const,
    publicMessage:
      "The PayPal fee on the checkout is out of date. Apply the fee again, then try again.",
    merchantMessage:
      "Payment intent not created - PayPal was chosen but the checkout's PayPal fee line is not the expected fee",
  },
});

/** Another method chosen, and the checkout holds a fee line. */
export const PaymentFeePresentError = PaymentMethodNotAllowedError.subclass(
  "PaymentFeePresentError",
  {
    props: {
      _internalName: "TransactionInitializeSession.PaymentFeePresentError" as const,
      publicMessage: "The checkout holds a PayPal fee. Remove the fee or choose PayPal.",
      merchantMessage:
        "Payment intent not created - a PayPal fee line is on the checkout but PayPal was not chosen",
    },
  },
);

export type PaymentMethodRefusal = InstanceType<
  typeof PaymentFeeRequiredError | typeof PaymentFeeStaleError | typeof PaymentFeePresentError
>;
