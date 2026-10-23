import { default as currencyCodesData } from "currency-codes";
import Stripe from "stripe";

import { PaymentFeeGateConfig } from "@/modules/payment-fee-gate/payment-fee-gate-config";
import { computeFeeCents } from "@/modules/payment-fee-gate/payment-fee-rule";
import {
  PAYMENT_POLICY_TRANSACTION_METADATA_KEY,
  readPaymentIntentPolicy,
} from "@/modules/payment-fee-gate/payment-method-policy";
import { isPaypalManualCapture } from "@/modules/payment-fee-gate/paypal-capture-method";
import { verifyPaymentFee } from "@/modules/payment-fee-gate/verify-payment-fee";
import { StripeMoney } from "@/modules/stripe/stripe-money";

import { CAPTURE_STATE_HELD, CAPTURE_STATE_METADATA_KEY } from "./capture-state-tags";

type Money = { readonly amount: number; readonly currency: string };
type MetadataItem = { readonly key: string; readonly value: string };

/** The PaymentIntent fields the rule reads: always the LIVE PaymentIntent (re-read just before). */
export type CapturePaymentIntent = Pick<
  Stripe.PaymentIntent,
  | "id"
  | "status"
  | "amount"
  | "amount_capturable"
  | "amount_received"
  | "currency"
  | "metadata"
  | "capture_method"
  | "payment_method_options"
  | "payment_method_types"
  | "excluded_payment_method_types"
  | "automatic_payment_methods"
>;

/** The app's DynamoDB RecordedTransaction for the PaymentIntent (written by transactionInitialize). */
export type CaptureRecord = {
  readonly saleorTransactionId: string;
  readonly stripePaymentIntentId: string;
  readonly saleorTransactionFlow: string;
};

/** Saleor (FetchCaptureTransaction, app token). */
export type CaptureOrderLine = {
  readonly productVariantId?: string | null;
  readonly quantity: number;
  readonly metadata: ReadonlyArray<MetadataItem>;
  readonly totalPrice: { readonly gross: Money };
};

export type CaptureOrderTransaction = {
  readonly id: string;
  readonly authorizedAmount: Money;
  readonly chargedAmount: Money;
  readonly authorizePendingAmount: Money;
  readonly chargePendingAmount: Money;
};

export type CaptureOrder = {
  readonly id: string;
  readonly number: string;
  readonly status: string;
  readonly total: { readonly gross: Money };
  readonly lines: ReadonlyArray<CaptureOrderLine>;
  readonly transactions: ReadonlyArray<CaptureOrderTransaction>;
  readonly payments: ReadonlyArray<{ readonly id: string; readonly isActive: boolean }>;
};

export type CaptureTransaction = {
  readonly id: string;
  readonly pspReference: string;
  readonly metadata: ReadonlyArray<MetadataItem>;
  readonly authorizedAmount: Money;
  readonly chargedAmount: Money;
  readonly refundedAmount: Money;
  readonly canceledAmount: Money;
  readonly authorizePendingAmount: Money;
  readonly chargePendingAmount: Money;
  readonly refundPendingAmount: Money;
  readonly cancelPendingAmount: Money;
  readonly checkout?: { readonly id: string } | null;
  readonly order?: CaptureOrder | null;
};

export type CaptureRule =
  | "R0"
  | "R1"
  | "R2"
  | "R3"
  | "R4"
  | "R5"
  | "R6"
  | "R7"
  | "R8"
  | "R9"
  | "R10"
  | "R11"
  | "R12"
  | "R13";

/**
 * Why an authorization is held for staff. The value of the Saleor transaction's public metadata
 * `stripe_capture_hold_reason` (ops alert and storefront contract). The last two come from the
 * coordinator, not from this rule.
 */
export const CAPTURE_HOLD_REASONS = [
  "policy-inconsistent",
  "link-mismatch",
  "policy-tag",
  "order-missing",
  "order-status",
  "ledger-mismatch",
  "other-payments",
  "currency-mismatch",
  "fee-absent",
  "overcharge-by-fee",
  "fee-invalid",
  "amount-mismatch",
  "capture-stuck",
  "release-stuck",
] as const;

export type CaptureHoldReason = (typeof CAPTURE_HOLD_REASONS)[number];

export type CaptureWaitReason =
  | "checkout-not-completed"
  | "order-unconfirmed"
  | "pending"
  | "authorization-not-recorded";

export type CaptureSkipReason =
  | "not-requires-capture"
  | "not-paypal-only"
  | "not-manual-capture"
  | "not-recorded"
  | "authorization-flow"
  | "transaction-not-found"
  | "already-held";

export type CaptureDecision =
  | { outcome: "capture"; rule: "R13"; amount: number; currency: string }
  | { outcome: "release"; rule: "R7" }
  | {
      outcome: "hold";
      rule: CaptureRule;
      reason: CaptureHoldReason;
      detail?: Readonly<Record<string, unknown>>;
    }
  | { outcome: "wait"; rule: CaptureRule; reason: CaptureWaitReason }
  | { outcome: "skip"; rule: CaptureRule; reason: CaptureSkipReason };

export type DecideCaptureInput = {
  paymentIntent: CapturePaymentIntent;
  record: CaptureRecord | null;
  transaction: CaptureTransaction | null;
  gate: Pick<PaymentFeeGateConfig, "ratePercent" | "variantId" | "metadataKey">;
};

/** Order statuses in which the lines can no longer change and the order is being served. */
const CAPTURABLE_ORDER_STATUSES: ReadonlySet<string> = new Set([
  "UNFULFILLED",
  "PARTIALLY_FULFILLED",
  "FULFILLED",
]);

const hold = (
  rule: CaptureRule,
  reason: CaptureHoldReason,
  detail?: Record<string, unknown>,
): CaptureDecision => ({ outcome: "hold", rule, reason, ...(detail && { detail }) });

const metadataValue = (metadata: ReadonlyArray<MetadataItem>, key: string) =>
  metadata.find((item) => item.key === key)?.value;

/** Saleor money in the currency's minor unit, as Stripe counts it; null when unconvertible. */
const toMinor = (money: Money): number | null => {
  const result = StripeMoney.createFromSaleorAmount({ amount: money.amount, currency: money.currency });

  return result.isOk() ? result.value.amount : null;
};

const isZero = (money: Money) => money.amount === 0;

const holdsMoney = (transaction: CaptureOrderTransaction) =>
  !isZero(transaction.authorizedAmount) ||
  !isZero(transaction.chargedAmount) ||
  !isZero(transaction.authorizePendingAmount) ||
  !isZero(transaction.chargePendingAmount);

/**
 * A3d capture rule (docs/plans/2026-10-22-paypal-fee-gate-design.md §9). First match wins:
 *
 * | Rule | Check                                                                    | Fails ->                                   |
 * | R0   | live PaymentIntent is requires_capture                                   | skip                                       |
 * | R1   | paypal-only by metadata AND live payment-method fields                   | skip (none/no-paypal), hold (inconsistent) |
 * | R2   | created for a manual PayPal capture                                      | skip                                       |
 * | R3   | DynamoDB record, PaymentIntent metadata and Saleor transaction agree;    | skip (not recorded, AUTHORIZATION flow:    |
 * |      | the Saleor flow is CHARGE (the app owes the capture)                     | staff capture, no transaction), hold       |
 * | R4   | transaction tag stripe_payment_policy = paypal-only                      | hold policy-tag                            |
 * | R5   | transaction not already held (stripe_capture_state)                      | skip already-held                          |
 * | R6   | the transaction is on an ORDER                                           | wait (still a checkout), hold (neither)    |
 * | R7   | order CANCELED -> RELEASE (OD1); UNCONFIRMED -> wait; must be            | hold order-status                          |
 * |      | UNFULFILLED / PARTIALLY_FULFILLED / FULFILLED                            |                                            |
 * | R8   | nothing pending on the transaction                                       | wait                                       |
 * | R9   | Saleor holds exactly this full authorization, nothing charged/refunded/  | wait (not recorded yet), hold              |
 * |      | canceled                                                                 |                                            |
 * | R10  | no other transaction of the order holds money, no active legacy payment  | hold other-payments                        |
 * | R11  | one 2-decimal currency everywhere                                        | hold currency-mismatch                     |
 * | R12  | verifyPaymentFee on the ORDER lines (productVariantId) is VALID          | hold fee-absent / overcharge-by-fee /      |
 * |      |                                                                          | fee-invalid                                |
 * | R13  | order total = PaymentIntent amount -> CAPTURE the order total            | hold amount-mismatch                       |
 *
 * R4 and R5 never block R7's release: a CANCELED order's authorization is released whatever
 * its tags. Never a smaller capture (OD2): capturing less on a fee-absent order would bring the
 * fee bypass back.
 */
export const decideCapture = (input: DecideCaptureInput): CaptureDecision => {
  const { paymentIntent, record, transaction, gate } = input;

  // R0 status
  if (paymentIntent.status !== "requires_capture") {
    return { outcome: "skip", rule: "R0", reason: "not-requires-capture" };
  }

  // R1 policy
  const policy = readPaymentIntentPolicy(paymentIntent);

  if (policy.kind === "inconsistent") {
    return hold("R1", "policy-inconsistent", { tagged: policy.tagged });
  }

  if (policy.kind === "legacy" || policy.policy !== "paypal-only") {
    return { outcome: "skip", rule: "R1", reason: "not-paypal-only" };
  }

  // R2 capture method
  if (!isPaypalManualCapture(paymentIntent)) {
    return { outcome: "skip", rule: "R2", reason: "not-manual-capture" };
  }

  // R3 link
  if (!record) {
    return { outcome: "skip", rule: "R3", reason: "not-recorded" };
  }

  if (record.stripePaymentIntentId !== paymentIntent.id) {
    return hold("R3", "link-mismatch", { recordPaymentIntentId: record.stripePaymentIntentId });
  }

  if (record.saleorTransactionFlow !== "CHARGE") {
    return { outcome: "skip", rule: "R3", reason: "authorization-flow" };
  }

  if (paymentIntent.metadata?.saleor_transaction_id !== record.saleorTransactionId) {
    return hold("R3", "link-mismatch", {
      paymentIntentTransactionId: paymentIntent.metadata?.saleor_transaction_id,
      recordTransactionId: record.saleorTransactionId,
    });
  }

  if (!transaction) {
    return { outcome: "skip", rule: "R3", reason: "transaction-not-found" };
  }

  if (transaction.id !== record.saleorTransactionId || transaction.pspReference !== paymentIntent.id) {
    return hold("R3", "link-mismatch", {
      transactionId: transaction.id,
      transactionPspReference: transaction.pspReference,
    });
  }

  const order = transaction.order ?? null;
  const orderCanceled = order?.status === "CANCELED";

  // R4 / R5 tags: they never block the release of a CANCELED order's authorization (OD1).
  if (!orderCanceled) {
    const policyTag = metadataValue(transaction.metadata, PAYMENT_POLICY_TRANSACTION_METADATA_KEY);

    if (policyTag !== "paypal-only") {
      return hold("R4", "policy-tag", { policyTag: policyTag ?? null });
    }

    if (metadataValue(transaction.metadata, CAPTURE_STATE_METADATA_KEY) === CAPTURE_STATE_HELD) {
      return { outcome: "skip", rule: "R5", reason: "already-held" };
    }
  }

  // R6 order present
  if (!order) {
    return transaction.checkout
      ? { outcome: "wait", rule: "R6", reason: "checkout-not-completed" }
      : hold("R6", "order-missing");
  }

  // R7 order status
  if (orderCanceled) {
    return { outcome: "release", rule: "R7" };
  }

  if (order.status === "UNCONFIRMED") {
    return { outcome: "wait", rule: "R7", reason: "order-unconfirmed" };
  }

  if (!CAPTURABLE_ORDER_STATUSES.has(order.status)) {
    return hold("R7", "order-status", { orderStatus: order.status });
  }

  // R8 nothing pending
  if (
    !isZero(transaction.authorizePendingAmount) ||
    !isZero(transaction.chargePendingAmount) ||
    !isZero(transaction.refundPendingAmount) ||
    !isZero(transaction.cancelPendingAmount)
  ) {
    return { outcome: "wait", rule: "R8", reason: "pending" };
  }

  // R9 ledger
  const nothingRecorded =
    isZero(transaction.authorizedAmount) &&
    isZero(transaction.chargedAmount) &&
    isZero(transaction.refundedAmount) &&
    isZero(transaction.canceledAmount);

  if (nothingRecorded) {
    // dess allows unpaid orders: the order can exist before Saleor records the authorization.
    return { outcome: "wait", rule: "R9", reason: "authorization-not-recorded" };
  }

  const authorizedMinor = toMinor(transaction.authorizedAmount);

  if (
    paymentIntent.amount_capturable !== paymentIntent.amount ||
    authorizedMinor !== paymentIntent.amount_capturable ||
    !isZero(transaction.chargedAmount) ||
    !isZero(transaction.refundedAmount) ||
    !isZero(transaction.canceledAmount)
  ) {
    return hold("R9", "ledger-mismatch", {
      amount: paymentIntent.amount,
      amountCapturable: paymentIntent.amount_capturable,
      saleorAuthorized: transaction.authorizedAmount.amount,
      saleorCharged: transaction.chargedAmount.amount,
      saleorRefunded: transaction.refundedAmount.amount,
      saleorCanceled: transaction.canceledAmount.amount,
    });
  }

  // R10 one payment only
  const otherPayments = order.transactions.filter(
    (orderTransaction) => orderTransaction.id !== transaction.id && holdsMoney(orderTransaction),
  );
  const activeLegacyPayments = order.payments.filter((payment) => payment.isActive);

  if (otherPayments.length > 0 || activeLegacyPayments.length > 0) {
    return hold("R10", "other-payments", {
      otherTransactions: otherPayments.map((t) => t.id),
      activeLegacyPayments: activeLegacyPayments.map((p) => p.id),
    });
  }

  // R11 currency
  const currency = paymentIntent.currency.toUpperCase();

  if (
    transaction.authorizedAmount.currency.toUpperCase() !== currency ||
    order.total.gross.currency.toUpperCase() !== currency ||
    currencyCodesData.code(currency)?.digits !== 2
  ) {
    return hold("R11", "currency-mismatch", {
      paymentIntentCurrency: paymentIntent.currency,
      transactionCurrency: transaction.authorizedAmount.currency,
      orderCurrency: order.total.gross.currency,
    });
  }

  // R12 PayPal fee on the ORDER lines; productVariantId keeps the ID of a deleted variant.
  const orderTotalMinor = toMinor(order.total.gross);
  const paymentFee = verifyPaymentFee(
    {
      totalPrice: order.total,
      lines: order.lines.map((line) => ({
        variant: { id: line.productVariantId ?? "" },
        quantity: line.quantity,
        metadata: line.metadata,
        totalPrice: line.totalPrice,
      })),
    },
    gate,
  );

  if (paymentFee.status === "ABSENT") {
    /*
     * The fee line was removed after approval and nothing replaced it: the authorization holds
     * the order total plus exactly the fee on it. Staff default (OD3): capture the order total
     * from the Dashboard; Stripe releases the rest.
     */
    const overchargeByFee =
      orderTotalMinor !== null &&
      orderTotalMinor > 0 &&
      paymentIntent.amount - orderTotalMinor === computeFeeCents(orderTotalMinor, gate.ratePercent) &&
      paymentIntent.amount > orderTotalMinor;

    return hold("R12", overchargeByFee ? "overcharge-by-fee" : "fee-absent", {
      orderTotal: order.total.gross.amount,
      paymentIntentAmount: paymentIntent.amount,
    });
  }

  if (paymentFee.status === "INVALID") {
    return hold("R12", "fee-invalid", {
      feeReason: paymentFee.reason,
      expectedFeeCents: paymentFee.expectedFeeCents,
      lineFeeCents: paymentFee.lineFeeCents,
    });
  }

  // R13 order total = PaymentIntent amount
  if (orderTotalMinor !== paymentIntent.amount) {
    return hold("R13", "amount-mismatch", {
      orderTotal: order.total.gross.amount,
      paymentIntentAmount: paymentIntent.amount,
    });
  }

  return {
    outcome: "capture",
    rule: "R13",
    amount: order.total.gross.amount,
    currency: order.total.gross.currency,
  };
};
