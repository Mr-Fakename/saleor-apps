import { default as currencyCodesData } from "currency-codes";

import { PaymentFeeGateConfig } from "./payment-fee-gate-config";
import { computeFeeCents, toCents } from "./payment-fee-rule";

type Amount = { readonly amount: number; readonly currency: string };
type Money = { readonly gross: Amount };

/** The line fields the check reads (Saleor `CheckoutLine`, read with the app token). */
export type PaymentFeeCheckoutLine = {
  readonly variant: { readonly id: string };
  readonly quantity: number;
  readonly metadata: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  /** The line total after every discount: what the shopper pays for the line. */
  readonly totalPrice: Money;
  /**
   * The line's OWN price: its total before discounts (`CheckoutLine.undiscountedTotalPrice`, or
   * `OrderLine.undiscountedTotalPrice.gross` on an order). For the fee line it is the custom price
   * (`price_override`) checkout-prices wrote, which only an app with HANDLE_CHECKOUTS can set.
   */
  readonly undiscountedTotalPrice: Amount;
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
  | "amount-mismatch"
  /** The fee line's discounted total is negative or above its own price. */
  | "discounted-total-out-of-range";

export type PaymentFeeState =
  | { status: "ABSENT" }
  | { status: "VALID"; baseCents: number; feeCents: number }
  | {
      status: "INVALID";
      reason: PaymentFeeInvalidReason;
      /**
       * For logs, when known: the fee the rule expects, the fee line's own price and its
       * discounted total.
       */
      expectedFeeCents?: number;
      ownFeeCents?: number;
      lineFeeCents?: number;
    };

/**
 * Is the checkout's PayPal fee line exactly what checkout-prices would write for this snapshot
 * (A3c §2a)?
 *
 * - ABSENT: no line carries the fee metadata key.
 * - VALID: exactly one fee line, on the fee variant, quantity 1, in the checkout currency (a
 *   2-decimal currency), with a positive base and a positive expected fee; the line's OWN price in
 *   cents equals the fee computed by checkout-prices' rule, and its discounted total is between 0
 *   and that own price.
 * - INVALID: anything else (duplicates, the marker forged onto a product line, another variant,
 *   an edited quantity, a stale amount after a shipping or voucher change, rate drift).
 *
 * Why the own price and not the discounted total (case A12): Saleor 3.22 spreads an ENTIRE_ORDER
 * voucher (apply_once_per_order=false) and an order promotion over ALL lines, the fee line
 * included, and gives the rounding remainder to the last line (usually the fee line, the newest):
 * checkout/base_calculations.py `_propagate_checkout_discount_on_checkout_lines_prices`. An
 * apply-once voucher goes to the cheapest line, which can be the fee line
 * (discount/utils/voucher.py): accepted, the shopper then pays less fee, never more than the rule.
 * The base stays the total minus the fee line's DISCOUNTED total, so a fee written for an old base
 * still fails.
 *
 * The own price is as forgery-proof as the old check: shoppers can write public line metadata
 * through Saleor's public API (A3b) but not prices (a custom price needs HANDLE_CHECKOUTS). On a
 * CHECKOUT it is reliable only because no writer changes a fee line's price IN PLACE:
 * checkout-prices replaces the line (add, then delete). Saleor 3.22 stores a copy of a line's own
 * price that a later price change can leave stale for up to CHECKOUT_PRICES_TTL (checkout/utils.py
 * :381-383 saves only quantity, price_override and metadata on an update; calculations.py
 * :513-517 can skip the refresh), while the INSERT writes the copy from the custom price
 * (utils.py :447-466). On an ORDER the own price is fixed at checkout completion from the live
 * custom price (checkout/complete_checkout.py :313-357).
 *
 * The rate and variant come from server env only.
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

  const currency = checkout.totalPrice.gross.currency.toUpperCase();

  if (
    feeLine.totalPrice.gross.currency.toUpperCase() !== currency ||
    feeLine.undiscountedTotalPrice.currency.toUpperCase() !== currency
  ) {
    return { status: "INVALID", reason: "currency-mismatch" };
  }

  if (currencyCodesData.code(currency)?.digits !== 2) {
    return { status: "INVALID", reason: "currency-not-2-decimal" };
  }

  const lineFeeCents = toCents(feeLine.totalPrice.gross.amount);
  const ownFeeCents = toCents(feeLine.undiscountedTotalPrice.amount);
  // checkout-prices src/pages/api/payment-fee.ts: base = toCents(total) − Σ toCents(fee lines)
  const baseCents =
    toCents(checkout.totalPrice.gross.amount) -
    feeLines.reduce((sum, line) => sum + toCents(line.totalPrice.gross.amount), 0);

  if (baseCents <= 0) {
    return { status: "INVALID", reason: "no-base", ownFeeCents, lineFeeCents };
  }

  const expectedFeeCents = computeFeeCents(baseCents, config.ratePercent);

  if (expectedFeeCents <= 0) {
    return { status: "INVALID", reason: "no-fee", expectedFeeCents, ownFeeCents, lineFeeCents };
  }

  if (ownFeeCents !== expectedFeeCents) {
    return {
      status: "INVALID",
      reason: "amount-mismatch",
      expectedFeeCents,
      ownFeeCents,
      lineFeeCents,
    };
  }

  if (lineFeeCents < 0 || lineFeeCents > ownFeeCents) {
    return {
      status: "INVALID",
      reason: "discounted-total-out-of-range",
      expectedFeeCents,
      ownFeeCents,
      lineFeeCents,
    };
  }

  return { status: "VALID", baseCents, feeCents: expectedFeeCents };
};
