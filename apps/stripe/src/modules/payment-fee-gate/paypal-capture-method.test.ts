import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { isPaypalManualCapture, paymentIntentMatchesPaypalCaptureMode } from "./paypal-capture-method";

type CaptureFields = Pick<Stripe.PaymentIntent, "capture_method" | "payment_method_options">;

/*
 * Spike S1 (sandbox, 2026-10-23): a PayPal PaymentIntent created with
 * payment_method_options.paypal.capture_method=manual reads top-level capture_method
 * "automatic_async"; the PayPal option is what makes it authorize only.
 */
const S1_MANUAL: CaptureFields = {
  capture_method: "automatic_async",
  payment_method_options: { paypal: { capture_method: "manual" } } as CaptureFields["payment_method_options"],
};

const AUTOMATIC: CaptureFields = {
  capture_method: "automatic_async",
  payment_method_options: { paypal: {} } as CaptureFields["payment_method_options"],
};

describe("isPaypalManualCapture (A3d)", () => {
  it("is true for the PayPal option manual with top-level automatic_async (S1)", () => {
    expect(isPaypalManualCapture(S1_MANUAL)).toBe(true);
  });

  it("is true for a top-level manual capture", () => {
    expect(isPaypalManualCapture({ capture_method: "manual", payment_method_options: null })).toBe(true);
  });

  it.each<CaptureFields>([
    AUTOMATIC,
    { capture_method: "automatic", payment_method_options: null },
    { capture_method: "automatic_async", payment_method_options: null },
  ])("is false for an automatic capture (%o)", (fields) => {
    expect(isPaypalManualCapture(fields)).toBe(false);
  });
});

describe("paymentIntentMatchesPaypalCaptureMode (A3d reuse rule)", () => {
  it("in manual mode, only a manual-capture PaymentIntent matches", () => {
    expect(paymentIntentMatchesPaypalCaptureMode(S1_MANUAL, "manual")).toBe(true);
    expect(paymentIntentMatchesPaypalCaptureMode(AUTOMATIC, "manual")).toBe(false);
  });

  it.each([null, undefined, "automatic" as const])(
    "with mode %s, any PaymentIntent matches (today's gate)",
    (mode) => {
      expect(paymentIntentMatchesPaypalCaptureMode(S1_MANUAL, mode)).toBe(true);
      expect(paymentIntentMatchesPaypalCaptureMode(AUTOMATIC, mode)).toBe(true);
    },
  );
});
