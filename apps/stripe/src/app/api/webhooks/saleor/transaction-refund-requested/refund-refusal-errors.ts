import { BaseError } from "@/lib/errors";

export const RefundRefusedErrorPublicCode = "RefundRefusedError" as const;

/**
 * The app answered REFUND_FAILURE although Stripe did not report an error of its own: this
 * request must not be reported as a refund. `merchantMessage` is what staff read on the
 * transaction in the Dashboard.
 */
const RefundRefusedError = BaseError.subclass("RefundRefusedError", {
  props: {
    _internalName: "TransactionRefundRequested.RefundRefusedError" as const,
    publicCode: RefundRefusedErrorPublicCode,
    publicMessage: "The refund was not created.",
    merchantMessage: "Refund not created",
  },
});

/**
 * Stripe answered idempotency_error: the refund key was already used with another amount.
 * With the v2 key that means staff edited the amount of a granted refund and retried it, and
 * the earlier attempt may have created a refund (review round 2, HIGH).
 */
export const RefundRequestChangedError = RefundRefusedError.subclass("RefundRequestChangedError", {
  props: {
    _internalName: "TransactionRefundRequested.RefundRequestChangedError" as const,
    merchantMessage:
      "Refund not created: amount changed after a possibly-successful attempt; create a new granted refund. Stripe already received this refund request with another amount, and that attempt may have refunded the customer: check the payment in Stripe first.",
  },
});

/**
 * A refund requested without a granted refund (v1 key): Stripe answered with a refund it
 * created for an earlier request with the same key, and Saleor already recorded that refund,
 * so no money moved now (review round 2, MEDIUM).
 */
export const RefundAlreadyRecordedError = RefundRefusedError.subclass(
  "RefundAlreadyRecordedError",
  {
    props: {
      _internalName: "TransactionRefundRequested.RefundAlreadyRecordedError" as const,
      merchantMessage:
        "Refund not created: identical refund within 24 h; use a granted refund. Stripe returned a refund of the same amount that is already recorded on this transaction, so no money moved.",
    },
  },
);

export type RefundRefusal = InstanceType<
  typeof RefundRequestChangedError | typeof RefundAlreadyRecordedError
>;
