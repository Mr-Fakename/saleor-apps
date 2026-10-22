import Stripe from "stripe";

import { PaymentFeeState } from "./verify-payment-fee";

/**
 * Which payment methods a PaymentIntent may offer with the PayPal-fee gate on (A3c §2d):
 * - paypal-only: allow-list `payment_method_types: ["paypal"]` (no automatic methods). Created
 *   only for a checkout whose fee line is VALID, so its amount includes the fee.
 * - no-paypal: `automatic_payment_methods` + `excluded_payment_method_types: ["paypal"]`.
 *
 * Stripe enforces both against publishable-key forgery (spike S0, F6–F8), and a PaymentIntent
 * cannot switch between them (S0): a change of choice cancels it and creates another (§3).
 */
export type PaymentMethodPolicy = "paypal-only" | "no-paypal";

/** PaymentIntent metadata key (storefront contract, §1c). */
export const PAYMENT_POLICY_METADATA_KEY = "saleor_payment_policy" as const;

/** Saleor transaction metadata key read by the stuck-payment alert (§6.3). */
export const PAYMENT_POLICY_TRANSACTION_METADATA_KEY = "stripe_payment_policy" as const;

/** Why transactionInitialize refuses the shopper's choice (public code PaymentMethodNotAllowedError). */
export type PaymentMethodRefusalCause = "fee-required" | "fee-stale" | "fee-present";

export type InitializePolicyDecision =
  | { outcome: "allowed"; policy: PaymentMethodPolicy }
  | { outcome: "refused"; cause: PaymentMethodRefusalCause };

/**
 * §2b, the transactionInitialize decision (gate on). `paymentFee` is null when there is no
 * checkout to verify (an Order source): PayPal is then refused and anything else is no-paypal.
 *
 * | paymentMethod | ABSENT              | VALID              | INVALID            |
 * | paypal        | refused fee-required| paypal-only        | refused fee-stale  |
 * | card / other  | no-paypal           | refused fee-present| refused fee-present|
 */
export const decideInitializePolicy = (args: {
  paymentMethod: string;
  paymentFee: PaymentFeeState | null;
}): InitializePolicyDecision => {
  const { paymentMethod, paymentFee } = args;

  if (paymentMethod === "paypal") {
    if (paymentFee?.status === "VALID") {
      return { outcome: "allowed", policy: "paypal-only" };
    }

    if (paymentFee?.status === "INVALID") {
      return { outcome: "refused", cause: "fee-stale" };
    }

    return { outcome: "refused", cause: "fee-required" };
  }

  if (paymentFee === null || paymentFee.status === "ABSENT") {
    return { outcome: "allowed", policy: "no-paypal" };
  }

  return { outcome: "refused", cause: "fee-present" };
};

/** The policy a live PaymentIntent holds, judged on its metadata AND its payment-method fields. */
export type PaymentIntentPolicyReading =
  | { kind: "policy"; policy: PaymentMethodPolicy }
  /** No policy metadata: created before the gate, or with the gate off. */
  | { kind: "legacy" }
  /** The metadata and the live fields disagree, or the tag is unknown: never trusted. */
  | { kind: "inconsistent"; tagged: string };

type PolicyFields = Pick<
  Stripe.PaymentIntent,
  "metadata" | "payment_method_types" | "excluded_payment_method_types" | "automatic_payment_methods"
>;

export const readPaymentIntentPolicy = (paymentIntent: PolicyFields): PaymentIntentPolicyReading => {
  const tagged = paymentIntent.metadata?.[PAYMENT_POLICY_METADATA_KEY];

  if (tagged === undefined || tagged === "") {
    return { kind: "legacy" };
  }

  const types = paymentIntent.payment_method_types ?? [];
  const excluded: ReadonlyArray<string> = paymentIntent.excluded_payment_method_types ?? [];

  if (
    tagged === "paypal-only" &&
    types.length === 1 &&
    types[0] === "paypal" &&
    !paymentIntent.automatic_payment_methods?.enabled
  ) {
    return { kind: "policy", policy: "paypal-only" };
  }

  if (tagged === "no-paypal" && excluded.includes("paypal") && !types.includes("paypal")) {
    return { kind: "policy", policy: "no-paypal" };
  }

  return { kind: "inconsistent", tagged };
};

export const paymentIntentHasPolicy = (
  paymentIntent: PolicyFields,
  policy: PaymentMethodPolicy,
): boolean => {
  const reading = readPaymentIntentPolicy(paymentIntent);

  return reading.kind === "policy" && reading.policy === policy;
};

/** update-payment-intent 409 codes (storefront contract, §1c). */
export type PaymentPolicyRefusalCode =
  | "PAYMENT_FEE_REQUIRED"
  | "PAYMENT_FEE_STALE"
  | "PAYMENT_FEE_PRESENT"
  | "PAYMENT_POLICY_REINIT";

export type UpdatePolicyDecision =
  | { outcome: "update" }
  | { outcome: "refused"; code: PaymentPolicyRefusalCode };

/**
 * §2c, the update-payment-intent decision (gate on): the policy comes from the PaymentIntent,
 * the fee state fresh from Saleor.
 *
 * | PaymentIntent           | ABSENT               | VALID               | INVALID             |
 * | paypal-only             | PAYMENT_FEE_REQUIRED | update              | PAYMENT_FEE_STALE   |
 * | no-paypal               | update               | PAYMENT_FEE_PRESENT | PAYMENT_FEE_PRESENT |
 * | legacy or inconsistent  | PAYMENT_POLICY_REINIT (always)                                   |
 */
export const decideUpdatePolicy = (args: {
  paymentIntentPolicy: PaymentIntentPolicyReading;
  paymentFee: PaymentFeeState;
}): UpdatePolicyDecision => {
  const { paymentIntentPolicy, paymentFee } = args;

  if (paymentIntentPolicy.kind !== "policy") {
    return { outcome: "refused", code: "PAYMENT_POLICY_REINIT" };
  }

  if (paymentIntentPolicy.policy === "paypal-only") {
    if (paymentFee.status === "VALID") {
      return { outcome: "update" };
    }

    return {
      outcome: "refused",
      code: paymentFee.status === "ABSENT" ? "PAYMENT_FEE_REQUIRED" : "PAYMENT_FEE_STALE",
    };
  }

  if (paymentFee.status === "ABSENT") {
    return { outcome: "update" };
  }

  return { outcome: "refused", code: "PAYMENT_FEE_PRESENT" };
};
