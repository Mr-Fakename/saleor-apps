import { BaseError } from "@/lib/errors";

export const CancelRefusedErrorPublicCode = "CancelRefusedError" as const;

/**
 * The app answered CANCEL_FAILURE without asking Stripe to cancel: the live PaymentIntent cannot
 * be cancelled. `merchantMessage` is what staff read on the transaction in the Dashboard.
 */
export const CancelRefusedError = BaseError.subclass("CancelRefusedError", {
  props: {
    _internalName: "TransactionCancelationRequested.CancelRefusedError" as const,
    publicCode: CancelRefusedErrorPublicCode,
    publicMessage: "The payment was not cancelled.",
    merchantMessage: "Cancel not made",
  },
});

/** The PaymentIntent is `succeeded`: the money was captured, only a refund gives it back. */
export const CancelAlreadyCapturedError = CancelRefusedError.subclass(
  "CancelAlreadyCapturedError",
  {
    props: {
      _internalName: "TransactionCancelationRequested.CancelAlreadyCapturedError" as const,
      merchantMessage:
        "Cancel not made: already captured: refund instead. The payment is captured in Stripe, so there is no authorization to release.",
    },
  },
);

export type CancelRefusal = InstanceType<typeof CancelAlreadyCapturedError>;
