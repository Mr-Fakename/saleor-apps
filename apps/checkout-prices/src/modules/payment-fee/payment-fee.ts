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
 *
 * The fee is written as the fee line's custom price, its OWN price
 * (`undiscountedTotalPrice`). Saleor 3.22 spreads an ENTIRE_ORDER voucher or an
 * order promotion over the fee line too, so its `totalPrice` can be lower; the
 * base above uses that discounted `totalPrice`. The Stripe app's check is
 * IDENTICAL (apps/stripe/src/modules/payment-fee-gate/payment-fee-rule.ts and
 * verify-payment-fee.ts): own price = fee, discounted total in [0, own price].
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

/**
 * True for the configured payment-fee variant (PAYMENT_FEE_VARIANT_ID); false
 * when none is configured (SDS). Endpoints other than /api/payment-fee must
 * never price a line on it: the Stripe app's own-price check holds only while
 * no writer changes a fee line's price in place. Decided by the VARIANT, not
 * the public marker, which shoppers can write onto any line.
 */
export function isPaymentFeeVariant(
  variantId: string,
  configuredVariantId: string | undefined = process.env.PAYMENT_FEE_VARIANT_ID,
): boolean {
  return !!configuredVariantId && variantId === configuredVariantId;
}

type FeeJudgeLine = {
  id: string;
  variant: { id: string };
  quantity: number;
  metadata: ReadonlyArray<{ key: string; value: string }>;
  totalPrice: { gross: { amount: number } };
  undiscountedTotalPrice: { amount: number };
};

export type PaymentFeeJudgement<L extends FeeJudgeLine> = {
  /** every line carrying the fee marker */
  feeLines: L[];
  /** toCents(total) − Σ toCents(fee lines' DISCOUNTED totals) */
  baseCents: number;
  /** the fee the rule asks for on that base */
  feeCents: number;
  /**
   * Exactly one fee line, on the fee variant, quantity 1, current marker, own price = fee.
   *
   * On purpose WITHOUT the Stripe app's range check (discounted total in [0, own price]):
   * Saleor gives the voucher spread's rounding remainder to the last line, which can push the
   * fee line above its own price (three 10.00 lines and a FIXED 0.02 voucher: 0.45 shows 0.46).
   * Rare, and more likely with small FIXED vouchers on carts with many lines (the remainder can
   * reach about half a cent per line). A swap cannot fix that (the new line is last again), so the state
   * is returned and the Stripe app refuses it with discounted-total-out-of-range.
   */
  settled: boolean;
};

/** One snapshot of the checkout under the fee rule (header comment). */
export function judgePaymentFee<L extends FeeJudgeLine>(
  checkout: { totalPrice: { gross: { amount: number } }; lines: ReadonlyArray<L> },
  config: { ratePercent: number; variantId: string },
): PaymentFeeJudgement<L> {
  const feeLines = checkout.lines.filter(isPaymentFeeLine);
  const baseCents =
    toCents(checkout.totalPrice.gross.amount) -
    feeLines.reduce((sum, line) => sum + toCents(line.totalPrice.gross.amount), 0);
  const feeCents = computeFeeCents(baseCents, config.ratePercent);
  const markerValue = feeMetadataValue(config.ratePercent);
  const [only] = feeLines;
  const settled =
    feeLines.length === 1 &&
    only.variant.id === config.variantId &&
    only.quantity === 1 &&
    toCents(only.undiscountedTotalPrice.amount) === feeCents &&
    only.metadata.some((m) => m.key === PAYMENT_FEE_METADATA_KEY && m.value === markerValue);

  return { feeLines, baseCents, feeCents, settled };
}
