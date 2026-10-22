import Stripe from "stripe";

/**
 * True when Stripe may have carried out the request although the app got an error: the
 * outcome is unknown, so the request must be repeated with the same idempotency key rather than
 * reported as failed (A2e).
 *
 * - StripeConnectionError: no answer, including stripe-node's own timeout ("Request aborted
 *   due to timeout being reached"); the request may have reached Stripe.
 * - StripeAPIError: Stripe's `api_error` (a problem on Stripe's side) or an answer that was not
 *   JSON, e.g. a gateway error page.
 * - Any Stripe error with HTTP status >= 500.
 * - HTTP 409 / `idempotency_key_in_use`: another request with the same key is still running at
 *   Stripe, and it may create the refund. Checked before the idempotency_error refusal.
 *
 * Every other Stripe error (card, invalid request, authentication, permission, rate limit,
 * idempotency key reused with other parameters) means Stripe did not carry out the request.
 */
export const isStripeOutcomeUnknown = (error: unknown): boolean => {
  if (error instanceof Stripe.errors.StripeConnectionError) {
    return true;
  }

  if (error instanceof Stripe.errors.StripeAPIError) {
    return true;
  }

  if (error instanceof Stripe.errors.StripeError) {
    const statusCode = error.statusCode ?? 0;

    return statusCode >= 500 || statusCode === 409 || error.code === "idempotency_key_in_use";
  }

  return false;
};
