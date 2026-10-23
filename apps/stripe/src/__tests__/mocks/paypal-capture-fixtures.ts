import { err, ok, Result } from "neverthrow";
import Stripe from "stripe";

import { CaptureHoldReason, CaptureTransaction } from "@/modules/paypal-capture/decide-capture";
import { ISaleorCaptureGateway, SaleorCaptureGatewayError } from "@/modules/paypal-capture/saleor-capture-gateway";
import { createResolvedTransactionFlow } from "@/modules/resolved-transaction-flow";
import { createSaleorTransactionFlow } from "@/modules/saleor/saleor-transaction-flow";
import { createSaleorTransactionId } from "@/modules/saleor/saleor-transaction-id";
import { createStripePaymentIntentId, StripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";
import { RecordedTransaction } from "@/modules/transactions-recording/domain/recorded-transaction";

/*
 * Shared A3d fixtures: a paypal-only authorization of 101.50 EUR (base 100.00 + fee 1.50) whose
 * Saleor transaction sits on an UNFULFILLED order that passes every capture rule.
 */

export const A3D_FEE_VARIANT_ID = "UHJvZHVjdFZhcmlhbnQ6NDQ5";
export const A3D_GATE = { method: "paypal" as const, ratePercent: 1.5, variantId: A3D_FEE_VARIANT_ID, metadataKey: "payment_fee_type" };
export const A3D_TX_ID = "VHJhbnNhY3Rpb25JdGVtOjQy";
export const A3D_ORDER_ID = "T3JkZXI6YTNk";

const eur = (amount: number) => ({ amount, currency: "EUR" });

export const a3dPaymentIntent = (
  id: string,
  overrides: Partial<Stripe.PaymentIntent> = {},
): Stripe.PaymentIntent =>
  ({
    id,
    object: "payment_intent",
    status: "requires_capture",
    amount: 101_50,
    amount_capturable: 101_50,
    amount_received: 0,
    currency: "eur",
    capture_method: "automatic_async",
    payment_method_options: { paypal: { capture_method: "manual" } },
    payment_method_types: ["paypal"],
    excluded_payment_method_types: null,
    automatic_payment_methods: null,
    canceled_at: null,
    cancellation_reason: null,
    ...overrides,
    metadata: {
      saleor_source_id: "Q2hlY2tvdXQ6YTNk",
      saleor_source_type: "Checkout",
      saleor_transaction_id: A3D_TX_ID,
      saleor_payment_policy: "paypal-only",
      ...overrides.metadata,
    },
  }) as Stripe.PaymentIntent;

export const a3dRecord = (paymentIntentId: string, transactionId = A3D_TX_ID) =>
  new RecordedTransaction({
    saleorTransactionId: createSaleorTransactionId(transactionId),
    stripePaymentIntentId: createStripePaymentIntentId(paymentIntentId),
    saleorTransactionFlow: createSaleorTransactionFlow("CHARGE"),
    resolvedTransactionFlow: createResolvedTransactionFlow("CHARGE"),
    selectedPaymentMethod: "paypal",
  });

export const a3dTransaction = (
  paymentIntentId: string,
  overrides: Partial<CaptureTransaction> = {},
  orderStatus = "UNFULFILLED",
): CaptureTransaction => ({
  id: A3D_TX_ID,
  pspReference: paymentIntentId,
  metadata: [{ key: "stripe_payment_policy", value: "paypal-only" }],
  authorizedAmount: eur(101.5),
  chargedAmount: eur(0),
  refundedAmount: eur(0),
  canceledAmount: eur(0),
  authorizePendingAmount: eur(0),
  chargePendingAmount: eur(0),
  refundPendingAmount: eur(0),
  cancelPendingAmount: eur(0),
  checkout: null,
  order: {
    id: A3D_ORDER_ID,
    number: "1201",
    status: orderStatus,
    total: { gross: eur(101.5) },
    lines: [
      { productVariantId: "UHJvZHVjdFZhcmlhbnQ6MTI=", quantity: 1, metadata: [], totalPrice: { gross: eur(100) } },
      {
        productVariantId: A3D_FEE_VARIANT_ID,
        quantity: 1,
        metadata: [{ key: "payment_fee_type", value: "paypal_1.5_percent" }],
        totalPrice: { gross: eur(1.5) },
      },
    ],
    transactions: [
      {
        id: A3D_TX_ID,
        authorizedAmount: eur(101.5),
        chargedAmount: eur(0),
        authorizePendingAmount: eur(0),
        chargePendingAmount: eur(0),
      },
    ],
    payments: [],
  },
  ...overrides,
});

/** Stripe, in memory: the coordinator only ever reads a PaymentIntent. */
export class FakeCaptureStripe {
  intents = new Map<string, Stripe.PaymentIntent>();
  failReads = false;
  reads: string[] = [];

  set(paymentIntent: Stripe.PaymentIntent) {
    this.intents.set(paymentIntent.id, paymentIntent);
  }

  update(id: string, changes: Partial<Stripe.PaymentIntent>) {
    const current = this.intents.get(id);

    if (current) {
      this.intents.set(id, { ...current, ...changes });
    }
  }

  async getPaymentIntent(args: { id: StripePaymentIntentId }): Promise<Result<Stripe.PaymentIntent, unknown>> {
    this.reads.push(args.id);

    if (this.failReads) {
      return err(new Stripe.errors.StripeConnectionError({ message: "timeout" } as Stripe.StripeRawError));
    }

    const pi = this.intents.get(args.id);

    return pi ? ok(pi) : err(new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: "missing" }));
  }
}

/**
 * Saleor, in memory. `onCharge` / `onCancel` model what happens after Saleor sends
 * TRANSACTION_CHARGE_REQUESTED / TRANSACTION_CANCELATION_REQUESTED to the app's handler.
 */
export class FakeCaptureSaleor implements ISaleorCaptureGateway {
  transaction: CaptureTransaction | null;
  fetchFails = false;
  requestFails = false;
  tagFails = false;
  requests: Array<{ action: "CHARGE" | "CANCEL"; transactionId: string; amount?: number }> = [];
  tags: Array<{ transactionId: string; reason: CaptureHoldReason; checkedAt: string }> = [];
  onCharge: () => void = () => {};
  onCancel: () => void = () => {};

  constructor(transaction: CaptureTransaction | null) {
    this.transaction = transaction;
  }

  async fetchTransaction(): Promise<Result<CaptureTransaction | null, InstanceType<typeof SaleorCaptureGatewayError>>> {
    if (this.fetchFails) {
      return err(new SaleorCaptureGatewayError("Saleor unavailable"));
    }

    return ok(this.transaction);
  }

  async requestCharge(args: { transactionId: string; amount: number }) {
    this.requests.push({ action: "CHARGE", ...args });

    if (this.requestFails) {
      return err(new SaleorCaptureGatewayError("transactionRequestAction failed"));
    }

    this.onCharge();

    return ok(undefined);
  }

  async requestCancel(args: { transactionId: string }) {
    this.requests.push({ action: "CANCEL", ...args });

    if (this.requestFails) {
      return err(new SaleorCaptureGatewayError("transactionRequestAction failed"));
    }

    this.onCancel();

    return ok(undefined);
  }

  async tagHold(args: { transactionId: string; reason: CaptureHoldReason; checkedAt: Date }) {
    if (this.tagFails) {
      return err(new SaleorCaptureGatewayError("transactionUpdate failed"));
    }

    this.tags.push({ transactionId: args.transactionId, reason: args.reason, checkedAt: args.checkedAt.toISOString() });

    if (this.transaction) {
      const others = this.transaction.metadata.filter((item) => !item.key.startsWith("stripe_capture_"));

      this.transaction = {
        ...this.transaction,
        metadata: [
          ...others,
          { key: "stripe_capture_state", value: "held" },
          { key: "stripe_capture_hold_reason", value: args.reason },
          { key: "stripe_capture_checked_at", value: args.checkedAt.toISOString() },
        ],
      };
    }

    return ok(undefined);
  }
}
