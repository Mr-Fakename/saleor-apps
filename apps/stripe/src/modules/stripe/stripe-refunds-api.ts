import { Result, ResultAsync } from "neverthrow";
import Stripe from "stripe";

import { StripeClient } from "./stripe-client";
import { StripeMoney } from "./stripe-money";
import { StripePaymentIntentId } from "./stripe-payment-intent-id";
import { StripeRestrictedKey } from "./stripe-restricted-key";
import { IStripeRefundsApi } from "./types";

/**
 * Bounds the refund call to answer Saleor in time (A2e (c)). Saleor 3.22.74 waits 2 s to
 * connect and 18 s for the answer to TRANSACTION_REFUND_REQUESTED (settings.WEBHOOK_SYNC_TIMEOUT)
 * and, when the app is slower, records a REFUND_FAILURE without retrying. stripe-node defaults
 * to 80 s per attempt and 2 retries.
 *
 * One attempt of 6 s (round 2, P2): an unknown outcome (timeout, 5xx) goes straight back to the
 * use case, which answers HTTP 503, and Saleor re-sends the request with the same idempotency
 * key (RefundOutcomeUnknownResponse). No stripe-node retry: it waits up to 60 s for a Retry-After
 * between attempts (RequestSender._getSleepTimeInMS), and a second attempt that gets a definite
 * error (e.g. 429) after the first one created the refund would be reported as REFUND_FAILURE.
 * stripe-node still retries once, 0.5 s later, when the connection was closed on the first
 * attempt (ECONNRESET/EPIPE, RequestSender._shouldRetry), so the worst case is 2 x 6 s + 0.5 s.
 */
const REFUND_REQUEST_TIMEOUT_MS = 6_000;
const REFUND_REQUEST_MAX_NETWORK_RETRIES = 0;

export class StripeRefundsApi implements IStripeRefundsApi {
  private stripeApiWrapper: Pick<Stripe, "refunds">;

  private constructor(stripeApiWrapper: Pick<Stripe, "refunds">) {
    this.stripeApiWrapper = stripeApiWrapper;
  }

  static createFromKey(args: { key: StripeRestrictedKey }) {
    const stripeApiWrapper = StripeClient.createFromRestrictedKey(args.key);

    return new StripeRefundsApi(stripeApiWrapper.nativeClient);
  }

  async createRefund(args: {
    paymentIntentId: StripePaymentIntentId;
    stripeMoney: StripeMoney;
    metadata?: Stripe.MetadataParam;
    idempotencyKey: string;
  }): Promise<Result<Stripe.Refund, unknown>> {
    return ResultAsync.fromPromise(
      this.stripeApiWrapper.refunds.create(
        {
          payment_intent: args.paymentIntentId,
          amount: args.stripeMoney.amount,
          metadata: args.metadata,
        },
        {
          idempotencyKey: args.idempotencyKey,
          timeout: REFUND_REQUEST_TIMEOUT_MS,
          maxNetworkRetries: REFUND_REQUEST_MAX_NETWORK_RETRIES,
        },
      ),
      (error) => error,
    );
  }
}
