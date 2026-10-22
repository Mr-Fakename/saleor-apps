import { default as currencyCodesData } from "currency-codes";

import { PaymentFeeGateConfig } from "./payment-fee-gate-config";
import { computeFeeCents, toCents } from "./payment-fee-rule";

type Money = { readonly gross: { readonly amount: number; readonly currency: string } };

/** The line fields the check reads (Saleor `CheckoutLine`, read with the app token). */
export type PaymentFeeCheckoutLine = {
  readonly variant: { readonly id: string };
  readonly quantity: number;
  readonly metadata: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly totalPrice: Money;
};

/** One snapshot of the checkout: its total and the lines it includes. */
export type PaymentFeeCheckout = {
  readonly totalPrice: Money;
  readonly lines: ReadonlyArray<PaymentFeeCheckoutLine>;
};

export type PaymentFeeInvalidReason =
  | "several-fee-lines"
  | "not-fee-variant"
  | "quantity-not-one"
  | "currency-mismatch"
  | "currency-not-2-decimal"
  | "no-base"
  | "no-fee"
  | "amount-mismatch";

export type PaymentFeeState =
  | { status: "ABSENT" }
  | { status: "VALID"; baseCents: number; feeCents: number }
  | {
      status: "INVALID";
      reason: PaymentFeeInvalidReason;
      /** For logs: the fee the rule expects and the fee the line holds, when known. */
      expectedFeeCents?: number;
      lineFeeCents?: number;
    };

/**
 * Is the checkout's PayPal fee line exactly what checkout-prices would write for this snapshot
 * (A3c §2a)?
 *
 * - ABSENT: no line carries the fee metadata key.
 * - VALID: exactly one fee line, on the fee variant, quantity 1, in the checkout currency (a
 *   2-decimal currency), with a positive base and a positive expected fee, and the line's gross
 *   total in cents equals the fee computed by checkout-prices' rule.
 * - INVALID: anything else (duplicates, the marker forged onto a product line, another variant,
 *   an edited quantity, a stale amount after a shipping or voucher change, rate drift).
 *
 * Shoppers can write public line metadata through Saleor's public API (A3b) but not prices, so
 * the amount check is what makes a forged marker useless. The rate and variant come from server
 * env only.
 */
export const verifyPaymentFee = (
  checkout: PaymentFeeCheckout,
  config: Pick<PaymentFeeGateConfig, "ratePercent" | "variantId" | "metadataKey">,
): PaymentFeeState => {
  const feeLines = checkout.lines.filter((line) =>
    line.metadata.some((item) => item.key === config.metadataKey),
  );

  if (feeLines.length === 0) {
    return { status: "ABSENT" };
  }

  if (feeLines.length > 1) {
    return { status: "INVALID", reason: "several-fee-lines" };
  }

  const [feeLine] = feeLines;

  if (feeLine.variant.id !== config.variantId) {
    return { status: "INVALID", reason: "not-fee-variant" };
  }

  if (feeLine.quantity !== 1) {
    return { status: "INVALID", reason: "quantity-not-one" };
  }

  const currency = checkout.totalPrice.gross.currency;

  if (feeLine.totalPrice.gross.currency.toUpperCase() !== currency.toUpperCase()) {
    return { status: "INVALID", reason: "currency-mismatch" };
  }

  if (currencyCodesData.code(currency.toUpperCase())?.digits !== 2) {
    return { status: "INVALID", reason: "currency-not-2-decimal" };
  }

  const lineFeeCents = toCents(feeLine.totalPrice.gross.amount);
  // checkout-prices src/pages/api/payment-fee.ts: base = toCents(total) − Σ toCents(fee lines)
  const baseCents =
    toCents(checkout.totalPrice.gross.amount) -
    feeLines.reduce((sum, line) => sum + toCents(line.totalPrice.gross.amount), 0);

  if (baseCents <= 0) {
    return { status: "INVALID", reason: "no-base", lineFeeCents };
  }

  const expectedFeeCents = computeFeeCents(baseCents, config.ratePercent);

  if (expectedFeeCents <= 0) {
    return { status: "INVALID", reason: "no-fee", expectedFeeCents, lineFeeCents };
  }

  if (lineFeeCents !== expectedFeeCents) {
    return { status: "INVALID", reason: "amount-mismatch", expectedFeeCents, lineFeeCents };
  }

  return { status: "VALID", baseCents, feeCents: expectedFeeCents };
};
