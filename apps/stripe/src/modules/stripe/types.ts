import { Result } from "neverthrow";
import Stripe from "stripe";

import { BaseError } from "@/lib/errors";
import { PaymentMethodPolicy } from "@/modules/payment-fee-gate/payment-method-policy";
import { SaleorTransationId } from "@/modules/saleor/saleor-transaction-id";
import { StripeWebhookSecret } from "@/modules/stripe/stripe-webhook-secret";

import { StripeMoney } from "./stripe-money";
import { StripePaymentIntentId } from "./stripe-payment-intent-id";
import { StripeRestrictedKey } from "./stripe-restricted-key";

export interface IStripePaymentIntentsApiFactory {
  create(args: { key: StripeRestrictedKey }): IStripePaymentIntentsApi;
}

export interface IStripeRefundsApiFactory {
  create(args: { key: StripeRestrictedKey }): IStripeRefundsApi;
}

export interface IStripeRefundsApi {
  createRefund(args: {
    paymentIntentId: StripePaymentIntentId;
    stripeMoney: StripeMoney;
    metadata?: AllowedStripeObjectMetadata;
    /**
     * Required: a retried request must not refund twice (NR-32).
     * See createStripeRefundIdempotencyKey.
     */
    idempotencyKey: string;
  }): Promise<Result<Stripe.Refund, unknown>>;
}

/**
 * Fixed metadata keys that are allowed on Stripe objects - intent and refund.
 */
export type AllowedStripeObjectMetadata = {
  saleor_transaction_id?: SaleorTransationId;
  saleor_source_id?: string;
  saleor_source_type?: "Checkout" | "Order";
  /**
   * PayPal-fee gate (A3c §2d): the payment methods the PaymentIntent was created with. Set only
   * with the gate on, at creation; never changed afterwards (a PaymentIntent cannot switch).
   */
  saleor_payment_policy?: PaymentMethodPolicy;
};

export interface CreatePaymentIntentArgs {
  stripeMoney: StripeMoney;
  intentParams: Pick<
    Stripe.PaymentIntentCreateParams,
    | "automatic_payment_methods"
    | "payment_method_types"
    | "excluded_payment_method_types"
    | "payment_method_options"
    | "confirm"
    | "payment_method"
    | "return_url"
  >;
  idempotencyKey: string;
  metadata?: AllowedStripeObjectMetadata;
}

export interface UpdatePaymentIntentArgs {
  id: StripePaymentIntentId;
  stripeMoney: StripeMoney;
  metadata?: AllowedStripeObjectMetadata;
  idempotencyKey?: string;
}

export interface IStripePaymentIntentsApi {
  createPaymentIntent(
    args: CreatePaymentIntentArgs,
  ): Promise<Result<Stripe.PaymentIntent, unknown>>;
  getPaymentIntent(args: {
    id: StripePaymentIntentId;
  }): Promise<Result<Stripe.PaymentIntent, unknown>>;
  /**
   * Update an existing PaymentIntent's amount and/or metadata.
   * According to Stripe best practices, when the checkout amount changes,
   * update the existing PaymentIntent instead of creating a new one.
   * The clientSecret remains valid after the update.
   */
  updatePaymentIntent(
    args: UpdatePaymentIntentArgs,
  ): Promise<Result<Stripe.PaymentIntent, unknown>>;
  /**
   * The live PaymentIntent, read in one bounded attempt: for the TRANSACTION_CHARGE_REQUESTED and
   * TRANSACTION_CANCELATION_REQUESTED handlers, which answer while Saleor waits.
   */
  getPaymentIntentForTransactionAction(args: {
    id: StripePaymentIntentId;
  }): Promise<Result<Stripe.PaymentIntent, unknown>>;
  /**
   * Captures `amountToCapture` (minor units) in one bounded attempt.
   * See createStripeCaptureIdempotencyKey.
   */
  capturePaymentIntent(args: {
    id: StripePaymentIntentId;
    amountToCapture: number;
    idempotencyKey: string;
  }): Promise<Result<Stripe.PaymentIntent, unknown>>;
  cancelPaymentIntent(args: {
    id: StripePaymentIntentId;
  }): Promise<Result<Stripe.PaymentIntent, unknown>>;
  /**
   * Cancels in one bounded attempt, for TRANSACTION_CANCELATION_REQUESTED.
   * See createStripeCancelIdempotencyKey.
   */
  cancelPaymentIntentForTransactionAction(args: {
    id: StripePaymentIntentId;
    idempotencyKey: string;
  }): Promise<Result<Stripe.PaymentIntent, unknown>>;
  searchPaymentIntentsByCheckout(args: {
    checkoutId: string;
  }): Promise<Result<Stripe.PaymentIntent[], unknown>>;
}

export interface IStripeEventVerify {
  verifyEvent({
    signatureHeader,
    webhookSecret,
    rawBody,
  }: {
    rawBody: string;
    signatureHeader: string;
    webhookSecret: StripeWebhookSecret;
  }): Result<Stripe.Event, InstanceType<typeof StripeEventParsingError>>;
}

export const StripeEventParsingError = BaseError.subclass("StripeEventParsingError", {
  props: {
    internalName: "StripeEventParsingError" as const,
  },
});
