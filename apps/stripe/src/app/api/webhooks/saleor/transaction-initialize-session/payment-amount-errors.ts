import { BaseError } from "@/lib/errors";

export const PaymentAmountRefusedErrorPublicCode = "PaymentAmountRefusedError" as const;

/**
 * The app refused to start a payment because the amount owed on the checkout cannot be
 * charged now (regression NR-31). No PaymentIntent was created or changed.
 */
export const PaymentAmountRefusedError = BaseError.subclass("PaymentAmountRefusedError", {
  props: {
    _internalName: "TransactionInitializeSession.PaymentAmountRefusedError" as const,
    publicCode: PaymentAmountRefusedErrorPublicCode,
    publicMessage: "The payment cannot be started for this checkout.",
    merchantMessage: "Payment intent not created - the checkout balance cannot be charged",
  },
});

export const CheckoutNotFoundError = PaymentAmountRefusedError.subclass("CheckoutNotFoundError", {
  props: {
    _internalName: "TransactionInitializeSession.CheckoutNotFoundError" as const,
    publicMessage: "Checkout not found.",
    merchantMessage: "Payment intent not created - Saleor did not return the checkout",
  },
});

export const CurrencyMismatchError = PaymentAmountRefusedError.subclass("CurrencyMismatchError", {
  props: {
    _internalName: "TransactionInitializeSession.CurrencyMismatchError" as const,
    publicMessage: "The payment currency does not match the checkout.",
    merchantMessage:
      "Payment intent not created - requested currency differs from the checkout or its payments",
  },
});

export const PaymentPendingError = PaymentAmountRefusedError.subclass("PaymentPendingError", {
  props: {
    _internalName: "TransactionInitializeSession.PaymentPendingError" as const,
    publicMessage: "Another payment for this checkout is still being processed.",
    merchantMessage: "Payment intent not created - another transaction of the checkout is pending",
  },
});

export const PaymentInFlightError = PaymentAmountRefusedError.subclass("PaymentInFlightError", {
  props: {
    _internalName: "TransactionInitializeSession.PaymentInFlightError" as const,
    publicMessage: "A payment for this checkout is already being processed.",
    merchantMessage:
      "Payment intent not created - a Stripe payment for the checkout is processing or paid but not yet recorded in Saleor",
  },
});

/**
 * The app could not make sure that the checkout's other PaymentIntents can no longer be paid
 * (review M1): another PaymentIntent could be neither read nor cancelled, the PaymentIntent
 * found by the Stripe search could not be read again (review round 2, Q4), or the Stripe
 * search failed for an order (a checkout goes on with its Saleor transactions, Q1). Handing
 * out a PaymentIntent then could let the shopper pay twice. Usually a temporary Stripe
 * problem: the shopper can retry.
 */
export const OtherPaymentsUnverifiedError = PaymentAmountRefusedError.subclass(
  "OtherPaymentsUnverifiedError",
  {
    props: {
      _internalName: "TransactionInitializeSession.OtherPaymentsUnverifiedError" as const,
      publicMessage: "The payment cannot be started right now. Please try again.",
      merchantMessage:
        "Payment intent not handed out - the checkout's other Stripe PaymentIntents could not be listed, checked or cancelled",
    },
  },
);

export const NothingDueError = PaymentAmountRefusedError.subclass("NothingDueError", {
  props: {
    _internalName: "TransactionInitializeSession.NothingDueError" as const,
    publicMessage: "Nothing is left to pay on this checkout.",
    merchantMessage: "Payment intent not created - the checkout is already fully paid",
  },
});

export type PaymentAmountRefusal = InstanceType<
  | typeof CheckoutNotFoundError
  | typeof CurrencyMismatchError
  | typeof PaymentPendingError
  | typeof PaymentInFlightError
  | typeof OtherPaymentsUnverifiedError
  | typeof NothingDueError
>;
