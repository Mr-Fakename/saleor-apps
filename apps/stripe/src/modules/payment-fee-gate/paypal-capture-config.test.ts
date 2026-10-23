import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAYPAL_CAPTURE_MODE,
  parsePaypalCaptureEnv,
  PaypalCaptureConfigError,
  paypalCaptureFromEnv,
} from "./paypal-capture-config";

/*
 * A3d (authorize, then capture): PAYMENT_FEE_PAYPAL_CAPTURE decides how a paypal-only
 * PaymentIntent is captured while the PayPal-fee gate is on.
 *   manual    (default with the gate on): authorized only; the app captures after it checked the order
 *   automatic (kill switch): Stripe captures at approval, as the gate did before A3d
 * Gate off: no effect at all (null). An unknown value stops the app at boot.
 */
describe("PayPal capture mode (A3d, PAYMENT_FEE_PAYPAL_CAPTURE)", () => {
  it("defaults to manual", () => {
    expect(DEFAULT_PAYPAL_CAPTURE_MODE).toBe("manual");
  });

  describe("gate on", () => {
    it.each<{ value: string | undefined; expected: "manual" | "automatic" }>([
      { value: undefined, expected: "manual" },
      { value: "", expected: "manual" },
      { value: "  ", expected: "manual" },
      { value: "manual", expected: "manual" },
      { value: " manual ", expected: "manual" },
      { value: "automatic", expected: "automatic" },
      { value: "automatic ", expected: "automatic" },
    ])("reads $value as $expected", ({ value, expected }) => {
      const raw = { PAYMENT_FEE_GATE: "paypal", PAYMENT_FEE_PAYPAL_CAPTURE: value };

      expect(parsePaypalCaptureEnv(raw)._unsafeUnwrap()).toBe(expected);
      expect(paypalCaptureFromEnv(raw)).toBe(expected);
    });
  });

  describe("gate off: no effect", () => {
    it.each<{ gate: string | undefined; value: string | undefined }>([
      { gate: undefined, value: undefined },
      { gate: "", value: undefined },
      { gate: undefined, value: "manual" },
      { gate: "", value: "automatic" },
    ])("is null with gate=$gate and value=$value", ({ gate, value }) => {
      const raw = { PAYMENT_FEE_GATE: gate, PAYMENT_FEE_PAYPAL_CAPTURE: value };

      expect(parsePaypalCaptureEnv(raw)._unsafeUnwrap()).toBeNull();
      expect(paypalCaptureFromEnv(raw)).toBeNull();
    });
  });

  describe("invalid values stop the app, gate on or off", () => {
    it.each(["Manual", "AUTOMATIC", "auto", "off", "true", "0"])("refuses %s", (value) => {
      for (const gate of ["paypal", undefined]) {
        const raw = { PAYMENT_FEE_GATE: gate, PAYMENT_FEE_PAYPAL_CAPTURE: value };

        expect(parsePaypalCaptureEnv(raw)._unsafeUnwrapErr()).toBeInstanceOf(
          PaypalCaptureConfigError,
        );
        expect(() => paypalCaptureFromEnv(raw)).toThrow(/PAYMENT_FEE_PAYPAL_CAPTURE/);
      }
    });
  });
});
