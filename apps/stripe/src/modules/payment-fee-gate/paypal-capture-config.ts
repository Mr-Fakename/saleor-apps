import { err, ok, Result } from "neverthrow";

import { BaseError } from "@/lib/errors";

/**
 * A3d, authorize then capture (docs/plans/2026-10-22-paypal-fee-gate-design.md §9): how a
 * paypal-only PaymentIntent is captured while the PayPal-fee gate is on.
 *
 *   PAYMENT_FEE_PAYPAL_CAPTURE=manual     default with the gate on. PayPal approval only
 *                                         authorizes; the app captures after it checked the
 *                                         ORDER (src/modules/paypal-capture/).
 *   PAYMENT_FEE_PAYPAL_CAPTURE=automatic  kill switch (OD4): Stripe captures at approval, as the
 *                                         gate did before A3d. The capture worker keeps running,
 *                                         so authorizations made before the switch are still
 *                                         checked and captured.
 *
 * Gate off: no effect (null), whatever the value. An unknown value stops the app at boot
 * (src/lib/env.ts), gate on or off.
 */
export type PaypalCaptureMode = "manual" | "automatic";

export const DEFAULT_PAYPAL_CAPTURE_MODE: PaypalCaptureMode = "manual";

export type PaypalCaptureEnv = {
  PAYMENT_FEE_GATE?: string;
  PAYMENT_FEE_PAYPAL_CAPTURE?: string;
};

export const PaypalCaptureConfigError = BaseError.subclass("PaypalCaptureConfigError", {
  props: {
    _internalName: "PaypalCaptureConfigError" as const,
  },
});

const PAYPAL_CAPTURE_MODES: ReadonlyArray<PaypalCaptureMode> = ["manual", "automatic"];

const isPaypalCaptureMode = (value: string): value is PaypalCaptureMode =>
  (PAYPAL_CAPTURE_MODES as ReadonlyArray<string>).includes(value);

export const parsePaypalCaptureEnv = (
  raw: PaypalCaptureEnv,
): Result<PaypalCaptureMode | null, InstanceType<typeof PaypalCaptureConfigError>> => {
  const value = (raw.PAYMENT_FEE_PAYPAL_CAPTURE ?? "").trim();

  if (value !== "" && !isPaypalCaptureMode(value)) {
    return err(
      new PaypalCaptureConfigError(
        `PAYMENT_FEE_PAYPAL_CAPTURE must be "manual", "automatic" or unset, got "${value}"`,
      ),
    );
  }

  if ((raw.PAYMENT_FEE_GATE ?? "").trim() === "") {
    return ok(null);
  }

  return ok(value === "" ? DEFAULT_PAYPAL_CAPTURE_MODE : (value as PaypalCaptureMode));
};

/**
 * The capture mode for the use cases, from the validated env. src/lib/env.ts already refused an
 * invalid value when it loaded, so this throws only if it is called with other values.
 */
export const paypalCaptureFromEnv = (raw: PaypalCaptureEnv): PaypalCaptureMode | null =>
  parsePaypalCaptureEnv(raw).match(
    (mode) => mode,
    (error) => {
      throw error;
    },
  );
