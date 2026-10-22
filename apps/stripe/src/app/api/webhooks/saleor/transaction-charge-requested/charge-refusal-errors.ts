import { BaseError } from "@/lib/errors";

export const ChargeRefusedErrorPublicCode = "ChargeRefusedError" as const;

/**
 * The app answered CHARGE_FAILURE without asking Stripe to capture: the live PaymentIntent
 * cannot be captured. `merchantMessage` is what staff read on the transaction in the Dashboard.
 */
export const ChargeRefusedError = BaseError.subclass("ChargeRefusedError", {
  props: {
    _internalName: "TransactionChargeRequested.ChargeRefusedError" as const,
    publicCode: ChargeRefusedErrorPublicCode,
    publicMessage: "The payment was not captured.",
    merchantMessage: "Capture not made",
  },
});

/** The PaymentIntent is `canceled`: staff released the authorization, or it expired. */
export const ChargeAuthorizationReleasedError = ChargeRefusedError.subclass(
  "ChargeAuthorizationReleasedError",
  {
    props: {
      _internalName: "TransactionChargeRequested.ChargeAuthorizationReleasedError" as const,
      merchantMessage:
        "Capture not made: authorization released or expired. The PaymentIntent is canceled in Stripe, so nothing can be captured.",
    },
  },
);

/** The PaymentIntent holds no authorization (requires_payment_method, _confirmation or _action). */
export const ChargeNotAuthorizedError = ChargeRefusedError.subclass("ChargeNotAuthorizedError", {
  props: {
    _internalName: "TransactionChargeRequested.ChargeNotAuthorizedError" as const,
    merchantMessage: "Capture not made: the payment is not authorized in Stripe.",
  },
});

/** Saleor asked for 0 (it sends min(requested, authorized), and the authorized amount was 0). */
export const ChargeNothingToCaptureError = ChargeRefusedError.subclass(
  "ChargeNothingToCaptureError",
  {
    props: {
      _internalName: "TransactionChargeRequested.ChargeNothingToCaptureError" as const,
      merchantMessage: "Capture not made: the requested amount is 0.",
    },
  },
);

export type ChargeRefusal = InstanceType<
  | typeof ChargeAuthorizationReleasedError
  | typeof ChargeNotAuthorizedError
  | typeof ChargeNothingToCaptureError
>;

/**
 * The refusal's message for staff, or null when the error is not a refusal (a Stripe error).
 *
 * Checks each refusal class, not the ChargeRefusedError parent: the subclasses override the
 * parent's literal-typed props (`_internalName`, `merchantMessage`), so TypeScript does not treat
 * their instances as parent instances and `instanceof ChargeRefusedError` narrows to `never`.
 */
export const getChargeRefusalMerchantMessage = (error: unknown): string | null => {
  if (
    error instanceof ChargeAuthorizationReleasedError ||
    error instanceof ChargeNotAuthorizedError ||
    error instanceof ChargeNothingToCaptureError
  ) {
    return error.merchantMessage;
  }

  return null;
};
