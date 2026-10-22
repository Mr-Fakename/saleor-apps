import Stripe from "stripe";

import { StripePaymentIntentId } from "./stripe-payment-intent-id";

/**
 * Stripe idempotency key for the capture the app makes for TRANSACTION_CHARGE_REQUESTED.
 *
 * When the app answers HTTP 503 (unknown outcome), Saleor re-sends the same stored payload
 * (webhook/transport/synchronous/transport.py handle_transaction_request_task), so the retry has
 * the same amount and the same key, and Stripe answers it with the first capture's result. The
 * amount is in the key: a request for another amount gets another key instead of Stripe's
 * idempotency_error. A PaymentIntent is captured once only, so a second capture with another key
 * gets a definite refusal, which the app answers under a failure pspReference of its own.
 *
 * Stripe keeps a key for at least 24 h and replays the first result, an error included.
 */
export const createStripeCaptureIdempotencyKey = (args: {
  stripePaymentIntentId: StripePaymentIntentId;
  /** In the currency's minor unit: what the app sends as `amount_to_capture`. */
  amountToCapture: number;
}): string => `capture:v1:${args.stripePaymentIntentId}:${args.amountToCapture}`;

/**
 * Stripe idempotency key for the cancel the app makes for TRANSACTION_CANCELATION_REQUESTED:
 * the PaymentIntent and the status the app read just before it cancels.
 *
 * Stripe stores a refused cancel (e.g. 400 payment_intent_unexpected_state) under its key and
 * replays it for at least 24 h. With the PaymentIntent alone in the key, a cancel refused because
 * the status changed between the read and the cancel blocked every later cancel for 24 h, also
 * a valid one once the PaymentIntent holds funds (requires_capture). The subscription carries no
 * per-request field to key on, and is not changed here.
 *
 * With the status in the key:
 * - Saleor's re-sent request (HTTP 503, same payload) that reads the same status uses the same
 *   key, so Stripe answers it with the first cancel's result. One that reads `canceled` (the
 *   first cancel happened) replays CANCEL_SUCCESS without a Stripe write.
 * - A cancel from another status uses another key: a refusal made from a status the
 *   PaymentIntent left is never replayed to it.
 * - The app cancels only from requires_payment_method, requires_confirmation, requires_action
 *   and requires_capture (`processing` is answered 503 with no write). A refusal from
 *   requires_capture means the PaymentIntent became succeeded or canceled, which are final, and
 *   the app reads those before any write. So a stored refusal can never block the release of a
 *   hold.
 * - Residual: a refusal stored from requires_payment_method, requires_confirmation or
 *   requires_action is replayed if the PaymentIntent is in that same status again within 24 h.
 *   No funds are held in those statuses; the app answers CANCEL_FAILURE (own pspReference).
 */
export const createStripeCancelIdempotencyKey = (args: {
  stripePaymentIntentId: StripePaymentIntentId;
  paymentIntentStatus: Stripe.PaymentIntent.Status;
}): string => `cancel:v1:${args.stripePaymentIntentId}:${args.paymentIntentStatus}`;
