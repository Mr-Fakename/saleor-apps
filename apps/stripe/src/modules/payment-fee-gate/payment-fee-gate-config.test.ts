import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAYMENT_FEE_METADATA_KEY,
  parsePaymentFeeGateEnv,
  PaymentFeeGateConfigError,
  paymentFeeGateFromEnv,
} from "./payment-fee-gate-config";

// base64("ProductVariant:449"), the dess fee variant (A3c §4).
const FEE_VARIANT_ID = "UHJvZHVjdFZhcmlhbnQ6NDQ5";

describe("PayPal-fee gate configuration (A3c §4)", () => {
  describe("gate off", () => {
    it.each<{ case: string; env: Record<string, string | undefined> }>([
      { case: "nothing set", env: {} },
      { case: "PAYMENT_FEE_GATE empty (compose ${VAR:-})", env: { PAYMENT_FEE_GATE: "" } },
      { case: "PAYMENT_FEE_GATE blank", env: { PAYMENT_FEE_GATE: "  " } },
      {
        case: "the other variables set without the gate",
        env: { PAYMENT_FEE_RATE_PERCENT: "1.5", PAYMENT_FEE_VARIANT_ID: FEE_VARIANT_ID },
      },
      {
        case: "invalid rate and variant without the gate (ignored)",
        env: { PAYMENT_FEE_RATE_PERCENT: "abc", PAYMENT_FEE_VARIANT_ID: "nope" },
      },
    ])("is off when $case", ({ env }) => {
      expect(parsePaymentFeeGateEnv(env)._unsafeUnwrap()).toBeNull();
      expect(paymentFeeGateFromEnv(env)).toBeNull();
    });
  });

  describe("gate on", () => {
    it("reads the rate, the variant and the default metadata key", () => {
      expect(
        parsePaymentFeeGateEnv({
          PAYMENT_FEE_GATE: "paypal",
          PAYMENT_FEE_RATE_PERCENT: "1.5",
          PAYMENT_FEE_VARIANT_ID: FEE_VARIANT_ID,
        })._unsafeUnwrap(),
      ).toStrictEqual({
        method: "paypal",
        ratePercent: 1.5,
        variantId: FEE_VARIANT_ID,
        metadataKey: DEFAULT_PAYMENT_FEE_METADATA_KEY,
      });
      expect(DEFAULT_PAYMENT_FEE_METADATA_KEY).toBe("payment_fee_type");
    });

    it("takes PAYMENT_FEE_METADATA_KEY when set, and trims the values", () => {
      expect(
        parsePaymentFeeGateEnv({
          PAYMENT_FEE_GATE: " paypal ",
          PAYMENT_FEE_RATE_PERCENT: " 2 ",
          PAYMENT_FEE_VARIANT_ID: ` ${FEE_VARIANT_ID} `,
          PAYMENT_FEE_METADATA_KEY: " fee_marker ",
        })._unsafeUnwrap(),
      ).toStrictEqual({
        method: "paypal",
        ratePercent: 2,
        variantId: FEE_VARIANT_ID,
        metadataKey: "fee_marker",
      });
    });

    it("uses the default metadata key when PAYMENT_FEE_METADATA_KEY is empty", () => {
      expect(
        parsePaymentFeeGateEnv({
          PAYMENT_FEE_GATE: "paypal",
          PAYMENT_FEE_RATE_PERCENT: "1.5",
          PAYMENT_FEE_VARIANT_ID: FEE_VARIANT_ID,
          PAYMENT_FEE_METADATA_KEY: "",
        })._unsafeUnwrap()?.metadataKey,
      ).toBe("payment_fee_type");
    });

    it.each<{ case: string; env: Record<string, string | undefined> }>([
      {
        case: "an unknown gate value",
        env: {
          PAYMENT_FEE_GATE: "PayPal",
          PAYMENT_FEE_RATE_PERCENT: "1.5",
          PAYMENT_FEE_VARIANT_ID: FEE_VARIANT_ID,
        },
      },
      {
        case: "no rate",
        env: { PAYMENT_FEE_GATE: "paypal", PAYMENT_FEE_VARIANT_ID: FEE_VARIANT_ID },
      },
      {
        case: "an empty rate",
        env: {
          PAYMENT_FEE_GATE: "paypal",
          PAYMENT_FEE_RATE_PERCENT: "",
          PAYMENT_FEE_VARIANT_ID: FEE_VARIANT_ID,
        },
      },
      ...["abc", "1,5", "0", "-1", "100.01", "Infinity", "NaN"].map((rate) => ({
        case: `rate "${rate}"`,
        env: {
          PAYMENT_FEE_GATE: "paypal",
          PAYMENT_FEE_RATE_PERCENT: rate,
          PAYMENT_FEE_VARIANT_ID: FEE_VARIANT_ID,
        },
      })),
      {
        case: "no variant",
        env: { PAYMENT_FEE_GATE: "paypal", PAYMENT_FEE_RATE_PERCENT: "1.5" },
      },
      ...[
        "",
        "449",
        "not-base64!",
        // base64("Product:449"): another object type
        "UHJvZHVjdDo0NDk=",
        // base64("ProductVariant:"): no primary key
        "UHJvZHVjdFZhcmlhbnQ6",
      ].map((variant) => ({
        case: `variant "${variant}"`,
        env: {
          PAYMENT_FEE_GATE: "paypal",
          PAYMENT_FEE_RATE_PERCENT: "1.5",
          PAYMENT_FEE_VARIANT_ID: variant,
        },
      })),
    ])("refuses $case", ({ env }) => {
      const error = parsePaymentFeeGateEnv(env)._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(PaymentFeeGateConfigError);
      expect(() => paymentFeeGateFromEnv(env)).toThrow(PaymentFeeGateConfigError);
    });

    it("accepts the upper bound of the rate, as checkout-prices does (0, 100]", () => {
      expect(
        parsePaymentFeeGateEnv({
          PAYMENT_FEE_GATE: "paypal",
          PAYMENT_FEE_RATE_PERCENT: "100",
          PAYMENT_FEE_VARIANT_ID: FEE_VARIANT_ID,
        })._unsafeUnwrap()?.ratePercent,
      ).toBe(100);
    });
  });
});
