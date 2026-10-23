/**
 * The PayPal service-fee rule, IDENTICAL to checkout-prices (A3c §2a), which writes the fee line
 * this app verifies:
 *
 *   fee = Math.round(base × rate / 100), base = toCents(checkout total) − Σ toCents(fee lines)
 *
 * The fee lines in the base are counted at their DISCOUNTED total (`totalPrice`). The fee is
 * written as the fee line's custom price, so it is compared with the line's OWN price
 * (`undiscountedTotalPrice`); its discounted total must be between 0 and that own price (an
 * order-level voucher can be spread over the fee line, case A12: verify-payment-fee.ts).
 *
 * Source: apps/checkout-prices/src/modules/payment-fee/payment-fee.ts (`toCents`,
 * `computeFeeCents`) and src/pages/api/payment-fee.ts (the base and the own-price check). Any
 * change there must be made here in the same change: payment-fee-rule.test.ts holds golden
 * vectors produced by checkout-prices' own functions.
 */

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** Fee in cents for a fee-exclusive base given in cents (half-cent rounds up). */
export function computeFeeCents(feeExclusiveTotalCents: number, ratePercent: number): number {
  return Math.round((feeExclusiveTotalCents * ratePercent) / 100);
}
