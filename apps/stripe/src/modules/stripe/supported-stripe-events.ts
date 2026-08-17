import type { Stripe } from "stripe";

export const supportedStripeEvents: Array<Stripe.WebhookEndpointCreateParams.EnabledEvent> = [
  "payment_intent.amount_capturable_updated",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_intent.requires_action",
  "payment_intent.succeeded",
  "payment_intent.canceled",

  "charge.refund.updated",

  /**
   * Refund-object events. They also cover refunds created OUTSIDE of Saleor (Stripe
   * Dashboard, Stripe API, a dispute-driven refund): "charge.refund.updated" alone only
   * fires on later status transitions, so a dashboard refund that succeeds immediately
   * would never reach the app and the order would stay "paid" in Saleor forever.
   */
  "refund.created",
  "refund.updated",
  "refund.failed",
];
