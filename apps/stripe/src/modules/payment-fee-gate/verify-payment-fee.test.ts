import { describe, expect, it } from "vitest";

import { PaymentFeeGateConfig } from "./payment-fee-gate-config";
import { PaymentFeeCheckout, PaymentFeeCheckoutLine, verifyPaymentFee } from "./verify-payment-fee";

const FEE_VARIANT_ID = "UHJvZHVjdFZhcmlhbnQ6NDQ5";
const PRODUCT_VARIANT_ID = "UHJvZHVjdFZhcmlhbnQ6MTI=";

const gate: PaymentFeeGateConfig = {
  method: "paypal",
  ratePercent: 1.5,
  variantId: FEE_VARIANT_ID,
  metadataKey: "payment_fee_type",
};

const eur = (amount: number, currency = "EUR") => ({ gross: { amount, currency } });

const productLine = (
  amount: number,
  overrides: Partial<PaymentFeeCheckoutLine> = {},
): PaymentFeeCheckoutLine => ({
  variant: { id: PRODUCT_VARIANT_ID },
  quantity: 2,
  metadata: [],
  totalPrice: eur(amount),
  ...overrides,
});

const feeLine = (
  amount: number,
  overrides: Partial<PaymentFeeCheckoutLine> = {},
): PaymentFeeCheckoutLine => ({
  variant: { id: FEE_VARIANT_ID },
  quantity: 1,
  // The value embeds the rate; lookups match the KEY only (as checkout-prices does).
  metadata: [
    { key: "payment_fee_type", value: "paypal_1.5_percent" },
    { key: "display_name", value: "Service fee (1.5%)" },
  ],
  totalPrice: eur(amount),
  ...overrides,
});

const checkout = (
  total: number,
  lines: PaymentFeeCheckoutLine[],
  currency = "EUR",
): PaymentFeeCheckout => ({
  totalPrice: eur(total, currency),
  lines,
});

describe("verifyPaymentFee (A3c §2a)", () => {
  it("is ABSENT when no line carries the fee key", () => {
    expect(verifyPaymentFee(checkout(210, [productLine(210)]), gate)).toStrictEqual({
      status: "ABSENT",
    });
  });

  it("is ABSENT for a line on the fee variant without the fee key", () => {
    expect(
      verifyPaymentFee(checkout(213.15, [productLine(210), feeLine(3.15, { metadata: [] })]), gate),
    ).toStrictEqual({ status: "ABSENT" });
  });

  it("is VALID for one correct fee line (210.00 + 1.5 % = 3.15)", () => {
    expect(verifyPaymentFee(checkout(213.15, [productLine(210), feeLine(3.15)]), gate)).toStrictEqual(
      { status: "VALID", baseCents: 21000, feeCents: 315 },
    );
  });

  it("is VALID when the base includes shipping and discounts (fee on the fee-exclusive total)", () => {
    // Lines 120, shipping 9.90, voucher -20: Saleor's total is 109.90 + fee 1.65 = 111.55.
    expect(
      verifyPaymentFee(checkout(111.55, [productLine(120), feeLine(1.65)]), gate),
    ).toStrictEqual({ status: "VALID", baseCents: 10990, feeCents: 165 });
  });

  it("matches the key whatever the marker value (a line written under an older rate)", () => {
    expect(
      verifyPaymentFee(
        checkout(213.15, [
          productLine(210),
          feeLine(3.15, { metadata: [{ key: "payment_fee_type", value: "paypal_2.9_percent" }] }),
        ]),
        gate,
      ).status,
    ).toBe("VALID");
  });

  it("uses the configured metadata key", () => {
    const otherKey = { ...gate, metadataKey: "fee_marker" };

    expect(verifyPaymentFee(checkout(213.15, [productLine(210), feeLine(3.15)]), otherKey)).toStrictEqual({
      status: "ABSENT",
    });
    expect(
      verifyPaymentFee(
        checkout(213.15, [
          productLine(210),
          feeLine(3.15, { metadata: [{ key: "fee_marker", value: "x" }] }),
        ]),
        otherKey,
      ).status,
    ).toBe("VALID");
  });

  it.each<{ case: string; checkout: PaymentFeeCheckout; reason: string }>([
    {
      case: "two fee lines",
      checkout: checkout(216.3, [productLine(210), feeLine(3.15), feeLine(3.15)]),
      reason: "several-fee-lines",
    },
    {
      case: "the marker forged onto a product line",
      checkout: checkout(210, [
        productLine(206.85),
        productLine(3.15, { metadata: [{ key: "payment_fee_type", value: "paypal_1.5_percent" }] }),
      ]),
      reason: "not-fee-variant",
    },
    {
      case: "a fee line on another variant",
      checkout: checkout(213.15, [
        productLine(210),
        feeLine(3.15, { variant: { id: PRODUCT_VARIANT_ID } }),
      ]),
      reason: "not-fee-variant",
    },
    {
      case: "a fee line with quantity 2",
      checkout: checkout(216.3, [productLine(210), feeLine(6.3, { quantity: 2 })]),
      reason: "quantity-not-one",
    },
    {
      case: "a fee line in another currency",
      checkout: checkout(213.15, [productLine(210), feeLine(3.15, { totalPrice: eur(3.15, "USD") })]),
      reason: "currency-mismatch",
    },
    {
      case: "a currency without 2 decimals (JPY)",
      checkout: checkout(
        21315,
        [
          productLine(21000, { totalPrice: eur(21000, "JPY") }),
          feeLine(315, { totalPrice: eur(315, "JPY") }),
        ],
        "JPY",
      ),
      reason: "currency-not-2-decimal",
    },
    {
      case: "a checkout made of the fee line only (no base)",
      checkout: checkout(3.15, [feeLine(3.15)]),
      reason: "no-base",
    },
    {
      case: "a base whose fee rounds to 0 (0.33 at 1.5 %)",
      checkout: checkout(0.33, [productLine(0.33), feeLine(0)]),
      reason: "no-fee",
    },
    {
      case: "a stale amount (shipping added after the fee: base 219.90, fee 3.15)",
      checkout: checkout(223.05, [productLine(219.9), feeLine(3.15)]),
      reason: "amount-mismatch",
    },
    {
      case: "a fee one cent low",
      checkout: checkout(213.14, [productLine(210), feeLine(3.14)]),
      reason: "amount-mismatch",
    },
    {
      case: "a fee one cent high",
      checkout: checkout(213.16, [productLine(210), feeLine(3.16)]),
      reason: "amount-mismatch",
    },
    {
      case: "a fee line set to 0",
      checkout: checkout(210, [productLine(210), feeLine(0)]),
      reason: "amount-mismatch",
    },
  ])("is INVALID for $case", ({ checkout: c, reason }) => {
    const state = verifyPaymentFee(c, gate);

    expect(state.status).toBe("INVALID");
    expect(state.status === "INVALID" && state.reason).toBe(reason);
  });

  it("checks the fee against the configured rate, not the marker value (rate drift fails closed)", () => {
    // A 1.5 % line checked with the gate at 2 %: refused.
    expect(
      verifyPaymentFee(checkout(213.15, [productLine(210), feeLine(3.15)]), {
        ...gate,
        ratePercent: 2,
      }).status,
    ).toBe("INVALID");
  });

  it("checks the variant against the configured variant (variant drift fails closed)", () => {
    expect(
      verifyPaymentFee(checkout(213.15, [productLine(210), feeLine(3.15)]), {
        ...gate,
        variantId: "UHJvZHVjdFZhcmlhbnQ6NDUw",
      }).status,
    ).toBe("INVALID");
  });
});
