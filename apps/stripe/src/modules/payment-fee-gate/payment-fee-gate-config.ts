import { err, ok, Result } from "neverthrow";

import { BaseError } from "@/lib/errors";

/**
 * PayPal-fee hard gate (A3c, docs/plans/2026-10-22-paypal-fee-gate-design.md §4).
 *
 * The Stripe app is the authority: with the gate on, PayPal is offered only on a PaymentIntent
 * created for a checkout that carries a correct fee line, and never next to the other methods.
 * One client per VPS (ADR-0009), so the flag is the app's environment:
 *
 *   PAYMENT_FEE_GATE=paypal            on (dess); unset or empty = off (SDS, rollback)
 *   PAYMENT_FEE_RATE_PERCENT=1.5       required when on; (0, 100], as checkout-prices
 *   PAYMENT_FEE_VARIANT_ID=<ID>        required when on; a Saleor ProductVariant ID
 *   PAYMENT_FEE_METADATA_KEY           optional; default "payment_fee_type"
 *
 * The rate and variant must be checkout-prices' values (one registry value): any drift makes
 * every fee line INVALID, so PayPal is refused (fails closed), never charged without its fee.
 */
export type PaymentFeeGateConfig = Readonly<{
  method: "paypal";
  ratePercent: number;
  variantId: string;
  metadataKey: string;
}>;

/** The raw variables, as src/lib/env.ts reads them. */
export type PaymentFeeGateEnv = {
  PAYMENT_FEE_GATE?: string;
  PAYMENT_FEE_RATE_PERCENT?: string;
  PAYMENT_FEE_VARIANT_ID?: string;
  PAYMENT_FEE_METADATA_KEY?: string;
};

/** Same key as checkout-prices (PAYMENT_FEE_METADATA_KEY there): lookups match the KEY only. */
export const DEFAULT_PAYMENT_FEE_METADATA_KEY = "payment_fee_type";

const MAX_PAYMENT_FEE_RATE_PERCENT = 100;

export const PaymentFeeGateConfigError = BaseError.subclass("PaymentFeeGateConfigError", {
  props: {
    _internalName: "PaymentFeeGateConfigError" as const,
  },
});

const isBlank = (value: string | undefined): boolean => value === undefined || value.trim() === "";

/** A Saleor ProductVariant global ID: base64("ProductVariant:<pk>"). */
const isProductVariantId = (value: string): boolean => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }

  try {
    return /^ProductVariant:[1-9][0-9]*$/.test(atob(value));
  } catch {
    return false;
  }
};

export const parsePaymentFeeGateEnv = (
  raw: PaymentFeeGateEnv,
): Result<PaymentFeeGateConfig | null, InstanceType<typeof PaymentFeeGateConfigError>> => {
  if (isBlank(raw.PAYMENT_FEE_GATE)) {
    return ok(null);
  }

  const gate = (raw.PAYMENT_FEE_GATE ?? "").trim();

  if (gate !== "paypal") {
    return err(
      new PaymentFeeGateConfigError(
        `PAYMENT_FEE_GATE must be "paypal" or unset, got "${gate}"`,
      ),
    );
  }

  if (isBlank(raw.PAYMENT_FEE_RATE_PERCENT)) {
    return err(
      new PaymentFeeGateConfigError(
        "PAYMENT_FEE_RATE_PERCENT is required when PAYMENT_FEE_GATE=paypal (checkout-prices' rate, e.g. 1.5)",
      ),
    );
  }

  const ratePercent = Number((raw.PAYMENT_FEE_RATE_PERCENT ?? "").trim());

  if (
    !Number.isFinite(ratePercent) ||
    ratePercent <= 0 ||
    ratePercent > MAX_PAYMENT_FEE_RATE_PERCENT
  ) {
    return err(
      new PaymentFeeGateConfigError(
        "PAYMENT_FEE_RATE_PERCENT is misconfigured: expected a number in (0, 100]",
      ),
    );
  }

  const variantId = (raw.PAYMENT_FEE_VARIANT_ID ?? "").trim();

  if (!isProductVariantId(variantId)) {
    return err(
      new PaymentFeeGateConfigError(
        "PAYMENT_FEE_VARIANT_ID is required when PAYMENT_FEE_GATE=paypal: the Saleor ProductVariant ID of the fee line (checkout-prices' value)",
      ),
    );
  }

  const metadataKey = isBlank(raw.PAYMENT_FEE_METADATA_KEY)
    ? DEFAULT_PAYMENT_FEE_METADATA_KEY
    : (raw.PAYMENT_FEE_METADATA_KEY ?? "").trim();

  return ok(Object.freeze({ method: "paypal" as const, ratePercent, variantId, metadataKey }));
};

/**
 * The gate for the use cases, from the validated env. src/lib/env.ts already refused an invalid
 * combination when it loaded, so this throws only if it is called with other values.
 */
export const paymentFeeGateFromEnv = (raw: PaymentFeeGateEnv): PaymentFeeGateConfig | null =>
  parsePaymentFeeGateEnv(raw).match(
    (config) => config,
    (error) => {
      throw error;
    },
  );
