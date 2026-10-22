import Stripe from "stripe";
import { z } from "zod";

const StripePaymentIntentStatusSchema = z
  .enum([
    "requires_action",
    "requires_confirmation",
    "requires_payment_method",
    "canceled",
    "processing",
    "requires_capture",
    "succeeded",
  ])
  .brand("StripePaymentIntentStatus");

export const createStripePaymentIntentStatus = (raw: string) =>
  StripePaymentIntentStatusSchema.parse(raw);

export type StripePaymentIntentStatus = z.infer<typeof StripePaymentIntentStatusSchema>;

/**
 * Statuses in which Stripe accepts a new `amount`. Anything else (processing,
 * requires_capture, succeeded, canceled) means money is already moving or done.
 * Stripe stays the final arbiter: it can still refuse an update.
 */
const AMOUNT_UPDATABLE_STATUSES: ReadonlySet<Stripe.PaymentIntent.Status> = new Set<
  Stripe.PaymentIntent.Status
>(["requires_payment_method", "requires_confirmation", "requires_action"]);

/**
 * Statuses in which the shopper's money is moving (processing), held (requires_capture)
 * or taken (succeeded).
 */
const MONEY_MOVING_STATUSES: ReadonlySet<Stripe.PaymentIntent.Status> = new Set<
  Stripe.PaymentIntent.Status
>(["processing", "requires_capture", "succeeded"]);

export const isPaymentIntentAmountUpdatable = (status: Stripe.PaymentIntent.Status): boolean =>
  AMOUNT_UPDATABLE_STATUSES.has(status);

export const isPaymentIntentMoneyMoving = (status: Stripe.PaymentIntent.Status): boolean =>
  MONEY_MOVING_STATUSES.has(status);
