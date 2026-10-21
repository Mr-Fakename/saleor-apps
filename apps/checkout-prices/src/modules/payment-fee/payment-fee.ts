/**
 * PayPal service-fee rules (dess only). The fee AMOUNT is always computed
 * here, server-side, from the checkout as Saleor reports it:
 *
 *   fee = round_to_cent( (checkout.totalPrice.gross − Σ existing fee lines' totalPrice.gross) × rate / 100 )
 *
 * i.e. the rate applies to the fee-EXCLUSIVE total (lines + shipping − discounts),
 * the same base the storefront uses (packages/checkout/.../StripeCheckoutForm.tsx),
 * so a re-application can never compound. The rate is server config
 * (PAYMENT_FEE_RATE_PERCENT, default 1.5); a caller may still send its own
 * `ratePercent`/`amount` for backward compatibility, but they are never charged.
 */

/** Line-metadata key that marks a fee line. Lookups match the KEY alone: the
 * value embeds the rate, so matching it would orphan lines written under an
 * older rate (storefront: client.config.ts integrations.paymentFee). */
export const PAYMENT_FEE_METADATA_KEY = "payment_fee_type";

export const DEFAULT_PAYMENT_FEE_RATE_PERCENT = 1.5;
const MAX_PAYMENT_FEE_RATE_PERCENT = 100;

/**
 * PAYMENT_FEE_RATE_PERCENT as a percentage in (0, 100]; the default when
 * unset/empty; null when set to anything else (callers must fail closed).
 */
export function readPaymentFeeRatePercent(raw: string | undefined = process.env.PAYMENT_FEE_RATE_PERCENT): number | null {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PAYMENT_FEE_RATE_PERCENT;
  }
  const rate = Number(raw.trim());

  return Number.isFinite(rate) && rate > 0 && rate <= MAX_PAYMENT_FEE_RATE_PERCENT ? rate : null;
}

export type PaymentFeeConfig =
  | { ok: true; ratePercent: number; variantId: string }
  | { ok: false; error: string };

/** Server config needed to CHARGE a fee (removing one needs none). */
export function readPaymentFeeConfig(): PaymentFeeConfig {
  const variantId = process.env.PAYMENT_FEE_VARIANT_ID;

  if (!variantId) {
    return {
      ok: false,
      error: "PAYMENT_FEE_VARIANT_ID is not configured. Please set a service variant ID for fee lines.",
    };
  }
  const ratePercent = readPaymentFeeRatePercent();

  if (ratePercent === null) {
    return { ok: false, error: "PAYMENT_FEE_RATE_PERCENT is misconfigured: expected a number in (0, 100]." };
  }

  return { ok: true, ratePercent, variantId };
}

export function isValidCallerRatePercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_PAYMENT_FEE_RATE_PERCENT;
}

// 1.5 -> "1.5", 1.50 -> "1.5", 3 -> "3"
function formatRate(ratePercent: number): string {
  return String(Number(ratePercent.toFixed(2)));
}

/** Marker value written onto NEW fee lines, e.g. "paypal_1.5_percent". */
export function feeMetadataValue(ratePercent: number): string {
  return `paypal_${formatRate(ratePercent)}_percent`;
}

export function feeDisplayName(ratePercent: number): string {
  return `Service fee (${formatRate(ratePercent)}%)`;
}

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function centsToDecimalString(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Fee in cents for a fee-exclusive base given in cents (half-cent rounds up). */
export function computeFeeCents(feeExclusiveTotalCents: number, ratePercent: number): number {
  return Math.round((feeExclusiveTotalCents * ratePercent) / 100);
}

export function isPaymentFeeLine(line: { metadata?: ReadonlyArray<{ key: string }> | null }): boolean {
  return !!line.metadata?.some((m) => m.key === PAYMENT_FEE_METADATA_KEY);
}
