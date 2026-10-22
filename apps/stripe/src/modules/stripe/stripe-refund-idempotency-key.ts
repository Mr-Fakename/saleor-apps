import { createHash } from "crypto";

import { SaleorGrantedRefundId } from "@/modules/saleor/saleor-granted-refund-id";
import { SaleorTransationId } from "@/modules/saleor/saleor-transaction-id";

import { StripeMoney } from "./stripe-money";
import { StripePaymentIntentId } from "./stripe-payment-intent-id";

const sha256 = (identity: ReadonlyArray<string | number>) =>
  createHash("sha256").update(JSON.stringify(identity)).digest("hex");

/**
 * Stripe idempotency key for the refund the app creates for a TRANSACTION_REFUND_REQUESTED
 * webhook (regressions NR-32, review M3).
 *
 * Why: if Stripe creates the refund but Saleor never gets the answer, Saleor either re-sends
 * the same delivery (HTTP 5xx; `handle_transaction_request_task` retries up to 5 times) or
 * records REFUND_FAILURE (timeout, no status code) and staff retry the refund. Without a key
 * each attempt is a new refund.
 *
 * v2, when the payload carries a granted refund: (granted refund, transaction), and NOT the
 * amount or currency. A granted refund is one refund request: Saleor re-sends it with the
 * same id, staff can retry it only after it FAILED (same id), and the next refund of the same
 * amount is another granted refund (another id, so another key). Saleor lets staff edit the
 * amount of a granted refund in NONE or FAILURE (order_grant_refund_update.py), and a FAILURE
 * can hide a refund Stripe did create (Saleor's call timed out). With the amount in the key,
 * the edited retry got a new key and refunded twice (review round 2, HIGH). Without it, the
 * edited retry reuses the key with another amount: Stripe answers idempotency_error and the
 * use case refuses the refund, so staff create a new granted refund instead.
 *
 * v1 otherwise (a refund requested without a granted refund, or a Saleor still on the old
 * subscription, whose payload has no `grantedRefund`): (transaction, PaymentIntent, amount,
 * currency). Unchanged since it was introduced, so a retry keeps its key across the deploy.
 * Known limit: within 24 h, a second refund of exactly the same amount on the same
 * transaction returns the first refund instead of creating one. The caller refuses it when
 * Saleor already recorded that refund, and logs the replay otherwise.
 *
 * Never keyed on `issuedAt`: a staff retry has a new one and would refund twice.
 *
 * Both: Stripe keeps a key for at least 24 h and answers a repeat with the FIRST result, so a
 * Stripe error is replayed instead of retried. Stripe rejects a key reused with other
 * parameters (idempotency_error): v1 has every refund parameter in the key, v2 not the amount
 * (on purpose, see above). Hashed so the key has a fixed length (Stripe allows 255
 * characters). The key changes from v1 to v2 for one refund request only if it is retried
 * across the webhook re-registration.
 */
export const createStripeRefundIdempotencyKey = (args: {
  saleorTransactionId: SaleorTransationId;
  stripePaymentIntentId: StripePaymentIntentId;
  stripeMoney: StripeMoney;
  saleorGrantedRefundId: SaleorGrantedRefundId | null;
}): string => {
  if (args.saleorGrantedRefundId) {
    return `saleor-refund-v2-${sha256([args.saleorGrantedRefundId, args.saleorTransactionId])}`;
  }

  return `saleor-refund-v1-${sha256([
    args.saleorTransactionId,
    args.stripePaymentIntentId,
    args.stripeMoney.amount,
    args.stripeMoney.currency,
  ])}`;
};
