import { Result, ResultAsync } from "neverthrow";
import Stripe from "stripe";

import { StripeClient } from "@/modules/stripe/stripe-client";

import { StripePaymentIntentId } from "./stripe-payment-intent-id";
import { StripeRestrictedKey } from "./stripe-restricted-key";
import { CreatePaymentIntentArgs, IStripePaymentIntentsApi, UpdatePaymentIntentArgs } from "./types";

/*
 * Bounds the Stripe calls made while Saleor waits for the answer to TRANSACTION_CHARGE_REQUESTED
 * or TRANSACTION_CANCELATION_REQUESTED. Saleor 3.22.74 waits 2 s to connect and 18 s for the
 * answer (settings.WEBHOOK_SYNC_TIMEOUT) and, when the app is slower, records its own failure
 * without a retry. stripe-node defaults to 80 s per attempt.
 *
 * One handler call makes one live read and at most one write, each in one attempt (the refund
 * pattern, StripeRefundsApi): an unknown outcome goes straight back to the use case, which
 * answers HTTP 503, and Saleor re-sends the request (handle_transaction_request_task), which
 * reads the PaymentIntent again and reuses the write's idempotency key. stripe-node still retries
 * once, 0.5 s later, when the connection was closed on the first attempt
 * (RequestSender._shouldRetry): worst case (2 x 2.5 s + 0.5 s) + (2 x 5 s + 0.5 s) = 16 s.
 */
const TRANSACTION_ACTION_READ_TIMEOUT_MS = 2_500;
const TRANSACTION_ACTION_WRITE_TIMEOUT_MS = 5_000;
const TRANSACTION_ACTION_MAX_NETWORK_RETRIES = 0;

/**
 * A3d sweep (docs/plans/2026-10-22-paypal-fee-gate-design.md §9): paypal-only authorizations
 * waiting for the app's capture. Stripe's search lags up to about a minute; the worker reads
 * each PaymentIntent again before it decides anything.
 */
export const PAYPAL_AWAITING_APP_CAPTURE_SEARCH_QUERY =
  'status:"requires_capture" AND metadata["saleor_payment_policy"]:"paypal-only"';

/** 10 pages of 100: far above any real backlog; the next sweep reads the rest. */
const PAYPAL_AWAITING_APP_CAPTURE_MAX_PAGES = 10;

export class StripePaymentIntentsApi implements IStripePaymentIntentsApi {
  private stripeApiWrapper: Pick<Stripe, "paymentIntents">;

  private constructor(stripeApiWrapper: Pick<Stripe, "paymentIntents">) {
    this.stripeApiWrapper = stripeApiWrapper;
  }

  static createFromKey(args: { key: StripeRestrictedKey }) {
    const stripeApiWrapper = StripeClient.createFromRestrictedKey(args.key);

    return new StripePaymentIntentsApi(stripeApiWrapper.nativeClient);
  }

  static createFromClient(client: StripeClient) {
    return new StripePaymentIntentsApi(client.nativeClient);
  }

  async createPaymentIntent(
    args: CreatePaymentIntentArgs,
  ): Promise<Result<Stripe.PaymentIntent, unknown>> {
    return ResultAsync.fromPromise(
      this.stripeApiWrapper.paymentIntents.create(
        {
          ...args.intentParams,
          amount: args.stripeMoney.amount,
          currency: args.stripeMoney.currency,
          ...(args.metadata && { metadata: args.metadata }),
        },
        {
          idempotencyKey: args.idempotencyKey,
        },
      ),
      (error) => error,
    );
  }

  async getPaymentIntent(args: {
    id: StripePaymentIntentId;
  }): Promise<Result<Stripe.PaymentIntent, unknown>> {
    return ResultAsync.fromPromise(
      this.stripeApiWrapper.paymentIntents.retrieve(args.id),
      (error) => error,
    );
  }

  /**
   * Update an existing PaymentIntent's amount and/or metadata.
   * The clientSecret remains valid after the update, so the storefront
   * can continue using the same Stripe Elements without remounting.
   */
  async updatePaymentIntent(
    args: UpdatePaymentIntentArgs,
  ): Promise<Result<Stripe.PaymentIntent, unknown>> {
    return ResultAsync.fromPromise(
      this.stripeApiWrapper.paymentIntents.update(
        args.id,
        {
          amount: args.stripeMoney.amount,
          currency: args.stripeMoney.currency,
          ...(args.metadata && { metadata: args.metadata }),
        },
        args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : undefined,
      ),
      (error) => error,
    );
  }

  async getPaymentIntentForTransactionAction(args: {
    id: StripePaymentIntentId;
  }): Promise<Result<Stripe.PaymentIntent, unknown>> {
    return ResultAsync.fromPromise(
      this.stripeApiWrapper.paymentIntents.retrieve(
        args.id,
        {},
        {
          timeout: TRANSACTION_ACTION_READ_TIMEOUT_MS,
          maxNetworkRetries: TRANSACTION_ACTION_MAX_NETWORK_RETRIES,
        },
      ),
      (error) => error,
    );
  }

  async capturePaymentIntent(args: {
    id: StripePaymentIntentId;
    amountToCapture: number;
    idempotencyKey: string;
  }): Promise<Result<Stripe.PaymentIntent, unknown>> {
    return ResultAsync.fromPromise(
      this.stripeApiWrapper.paymentIntents.capture(
        args.id,
        { amount_to_capture: args.amountToCapture },
        {
          idempotencyKey: args.idempotencyKey,
          timeout: TRANSACTION_ACTION_WRITE_TIMEOUT_MS,
          maxNetworkRetries: TRANSACTION_ACTION_MAX_NETWORK_RETRIES,
        },
      ),
      (error) => error,
    );
  }

  async cancelPaymentIntent(args: {
    id: StripePaymentIntentId;
  }): Promise<Result<Stripe.PaymentIntent, unknown>> {
    return ResultAsync.fromPromise(
      this.stripeApiWrapper.paymentIntents.cancel(args.id),
      (error) => error,
    );
  }

  async cancelPaymentIntentForTransactionAction(args: {
    id: StripePaymentIntentId;
    idempotencyKey: string;
  }): Promise<Result<Stripe.PaymentIntent, unknown>> {
    return ResultAsync.fromPromise(
      this.stripeApiWrapper.paymentIntents.cancel(
        args.id,
        {},
        {
          idempotencyKey: args.idempotencyKey,
          timeout: TRANSACTION_ACTION_WRITE_TIMEOUT_MS,
          maxNetworkRetries: TRANSACTION_ACTION_MAX_NETWORK_RETRIES,
        },
      ),
      (error) => error,
    );
  }

  /** A3d sweep: see PAYPAL_AWAITING_APP_CAPTURE_SEARCH_QUERY. */
  async searchPaymentIntentsAwaitingAppCapture(): Promise<Result<Stripe.PaymentIntent[], unknown>> {
    return ResultAsync.fromPromise(
      (async () => {
        const found: Stripe.PaymentIntent[] = [];
        let page: string | undefined;

        for (let pageNumber = 0; pageNumber < PAYPAL_AWAITING_APP_CAPTURE_MAX_PAGES; pageNumber += 1) {
          const response = await this.stripeApiWrapper.paymentIntents.search({
            query: PAYPAL_AWAITING_APP_CAPTURE_SEARCH_QUERY,
            limit: 100,
            ...(page ? { page } : {}),
          });

          found.push(...response.data);

          if (!response.has_more || !response.next_page) {
            break;
          }

          page = response.next_page;
        }

        return found;
      })(),
      (error) => error,
    );
  }

  async searchPaymentIntentsByCheckout(args: {
    checkoutId: string;
  }): Promise<Result<Stripe.PaymentIntent[], unknown>> {
    return ResultAsync.fromPromise(
      this.stripeApiWrapper.paymentIntents
        .search({
          query: `metadata['saleor_source_id']:'${args.checkoutId}' AND status:'requires_payment_method'`,
          limit: 100,
        })
        .then((response) => response.data),
      (error) => error,
    );
  }
}
