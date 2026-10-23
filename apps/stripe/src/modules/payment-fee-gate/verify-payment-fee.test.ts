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

/*
 * Without an order-level discount, Saleor's own price of a line (CheckoutLine.undiscountedTotalPrice)
 * equals its total, so both helpers default it to the total's gross. The voucher cases set it.
 */
const productLine = (
  amount: number,
  overrides: Partial<PaymentFeeCheckoutLine> = {},
): PaymentFeeCheckoutLine => {
  const totalPrice = overrides.totalPrice ?? eur(amount);

  return {
    variant: { id: PRODUCT_VARIANT_ID },
    quantity: 2,
    metadata: [],
    totalPrice,
    undiscountedTotalPrice: totalPrice.gross,
    ...overrides,
  };
};

const feeLine = (
  amount: number,
  overrides: Partial<PaymentFeeCheckoutLine> = {},
): PaymentFeeCheckoutLine => {
  const totalPrice = overrides.totalPrice ?? eur(amount);

  return {
    variant: { id: FEE_VARIANT_ID },
    quantity: 1,
    // The value embeds the rate; lookups match the KEY only (as checkout-prices does).
    metadata: [
      { key: "payment_fee_type", value: "paypal_1.5_percent" },
      { key: "display_name", value: "Service fee (1.5%)" },
    ],
    totalPrice,
    undiscountedTotalPrice: totalPrice.gross,
    ...overrides,
  };
};

/** A fee line whose own price (the custom price checkout-prices wrote) differs from its total. */
const voucheredFeeLine = (own: number, discounted: number) =>
  feeLine(discounted, { undiscountedTotalPrice: { amount: own, currency: "EUR" } });

/** A product line of 94.10 that an ENTIRE_ORDER voucher of 10 % brought to 84.69 (case A12). */
const voucheredProductLine = () =>
  productLine(84.69, { quantity: 1, undiscountedTotalPrice: { amount: 94.1, currency: "EUR" } });

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

/*
 * Case A12 (Stripe sandbox): an ENTIRE_ORDER voucher (10 %, apply_once_per_order=false) is
 * spread by Saleor 3.22 over ALL lines, the fee line included. checkout-prices wrote the fee line's
 * custom price 1.36 (1.5 % of the fee-exclusive base 90.59); Saleor discounted it to 1.22, and the
 * checkout total is 91.81. The fee line's OWN price is what the rule checks; its discounted total
 * only feeds the base.
 */
describe("verifyPaymentFee with an order-level voucher on the fee line (A12)", () => {
  it("is VALID when the own price is the fee for the base (own 1.36, discounted 1.22, total 91.81)", () => {
    expect(
      verifyPaymentFee(checkout(91.81, [voucheredProductLine(), voucheredFeeLine(1.36, 1.22)]), gate),
    ).toStrictEqual({ status: "VALID", baseCents: 9059, feeCents: 136 });
  });

  it("is VALID when the voucher took the whole fee line (apply-once voucher on the cheapest line)", () => {
    expect(
      verifyPaymentFee(checkout(90.59, [voucheredProductLine(), voucheredFeeLine(1.36, 0)]), gate),
    ).toStrictEqual({ status: "VALID", baseCents: 9059, feeCents: 136 });
  });

  it("is INVALID amount-mismatch when the own price is not the fee, even if the discounted total is", () => {
    // own 1.50 for an expected 1.36; the discounted total happens to be 1.36 (the old rule passed it).
    expect(
      verifyPaymentFee(checkout(91.95, [voucheredProductLine(), voucheredFeeLine(1.5, 1.36)]), gate),
    ).toStrictEqual({
      status: "INVALID",
      reason: "amount-mismatch",
      expectedFeeCents: 136,
      ownFeeCents: 150,
      lineFeeCents: 136,
    });
  });

  it("is INVALID amount-mismatch for a fee written before the voucher (A12b: own 1.50, discounted 1.35)", () => {
    const state = verifyPaymentFee(
      checkout(91.94, [voucheredProductLine(), voucheredFeeLine(1.5, 1.35)]),
      gate,
    );

    expect(state.status === "INVALID" && state.reason).toBe("amount-mismatch");
  });

  it("is INVALID discounted-total-out-of-range when the discounted total is above the own price", () => {
    expect(
      verifyPaymentFee(checkout(92.09, [voucheredProductLine(), voucheredFeeLine(1.36, 1.5)]), gate),
    ).toStrictEqual({
      status: "INVALID",
      reason: "discounted-total-out-of-range",
      expectedFeeCents: 136,
      ownFeeCents: 136,
      lineFeeCents: 150,
    });
  });

  it("is INVALID discounted-total-out-of-range when the discounted total is negative", () => {
    const state = verifyPaymentFee(
      checkout(90.58, [voucheredProductLine(), voucheredFeeLine(1.36, -0.01)]),
      gate,
    );

    expect(state.status === "INVALID" && state.reason).toBe("discounted-total-out-of-range");
  });

  it("is INVALID currency-mismatch when the own price is in another currency", () => {
    const state = verifyPaymentFee(
      checkout(91.81, [
        voucheredProductLine(),
        feeLine(1.22, { undiscountedTotalPrice: { amount: 1.36, currency: "USD" } }),
      ]),
      gate,
    );

    expect(state.status === "INVALID" && state.reason).toBe("currency-mismatch");
  });

  it("still fails a fee written for an old base (shipping added after the voucher and the fee)", () => {
    // Same lines as A12, 9.90 shipping added: base 100.49 needs 1.51, the line still holds 1.36.
    const state = verifyPaymentFee(
      checkout(101.71, [voucheredProductLine(), voucheredFeeLine(1.36, 1.22)]),
      gate,
    );

    expect(state.status === "INVALID" && state.reason).toBe("amount-mismatch");
  });

  it("is VALID on a tax-exempt checkout: own 15.00, line net 12.50 (20 % VAT), base net 1000.00", () => {
    // dess: prices entered with tax; taxExemptionManage makes Saleor cut each line's gross to net
    // (checkout/calculations.py _remove_tax), while the own price stays the custom price. The
    // shopper pays the fee net of VAT, as with the gate off.
    expect(
      verifyPaymentFee(
        checkout(1012.5, [
          productLine(1000, { quantity: 1, undiscountedTotalPrice: { amount: 1200, currency: "EUR" } }),
          voucheredFeeLine(15, 12.5),
        ]),
        gate,
      ),
    ).toStrictEqual({ status: "VALID", baseCents: 100000, feeCents: 1500 });
  });

  it("refuses a fee line that the spread's last-line remainder put above its own price (0.45 shown 0.46)", () => {
    // Three 10.00 lines and a FIXED 0.02 voucher: each product share rounds up to 0.01, so the
    // last line (the fee) gets -0.01 (base_calculations.py _propagate_checkout_discount_on_
    // checkout_lines_prices). checkout-prices does not swap it (the new line is last again).
    const product = () => productLine(9.99, { quantity: 1, undiscountedTotalPrice: { amount: 10, currency: "EUR" } });

    expect(
      verifyPaymentFee(checkout(30.43, [product(), product(), product(), voucheredFeeLine(0.45, 0.46)]), gate),
    ).toStrictEqual({
      status: "INVALID",
      reason: "discounted-total-out-of-range",
      expectedFeeCents: 45,
      ownFeeCents: 45,
      lineFeeCents: 46,
    });
  });

  it("without a voucher, behaves as before: own price = total, VALID for 3.15 on 210.00", () => {
    expect(verifyPaymentFee(checkout(213.15, [productLine(210), feeLine(3.15)]), gate)).toStrictEqual(
      { status: "VALID", baseCents: 21000, feeCents: 315 },
    );
  });
});
