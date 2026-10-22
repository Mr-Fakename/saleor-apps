/**
 * The PayPal service-fee rule, IDENTICAL to checkout-prices (A3c §2a), which writes the fee line
 * this app verifies:
 *
 *   fee = Math.round(base × rate / 100), base = toCents(checkout total) − Σ toCents(fee lines)
 *
 * Source: apps/checkout-prices/src/modules/payment-fee/payment-fee.ts (`toCents`,
 * `computeFeeCents`) and src/pages/api/payment-fee.ts (the base). Any change there must be made
 * here in the same change: payment-fee-rule.test.ts holds golden vectors produced by
 * checkout-prices' own functions.
 */

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** Fee in cents for a fee-exclusive base given in cents (half-cent rounds up). */
export function computeFeeCents(feeExclusiveTotalCents: number, ratePercent: number): number {
  return Math.round((feeExclusiveTotalCents * ratePercent) / 100);
}
