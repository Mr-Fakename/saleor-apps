import { describe, expect, it } from "vitest";

import { computeFeeCents, toCents } from "./payment-fee-rule";

/*
 * Rule parity with checkout-prices (A3c §2a). The checkout-prices app writes the fee line; this
 * app verifies it. Both must compute the same cents, or PayPal is refused for a correct fee.
 *
 * Golden vectors: produced on 2026-10-22 by running checkout-prices' own functions
 * (apps/checkout-prices/src/modules/payment-fee/payment-fee.ts `toCents`, `computeFeeCents`)
 * on these inputs. They include the half-cent cases where a different rounding would differ.
 */
describe("PayPal fee rule (parity with checkout-prices)", () => {
  it.each<[number, number]>([
    [19.99, 1999],
    [0.1 + 0.2, 30],
    [1.005, 100],
    [2.675, 268],
    [103.15, 10315],
    [213.15, 21315],
    [0.015, 2],
    [49.995, 5000],
    [1234.565, 123457],
  ])("toCents(%s) = %s", (amount, cents) => {
    expect(toCents(amount)).toBe(cents);
  });

  it.each<{ baseCents: number; ratePercent: number; feeCents: number }>([
    { baseCents: 21000, ratePercent: 1.5, feeCents: 315 },
    { baseCents: 21000, ratePercent: 2, feeCents: 420 },
    { baseCents: 21000, ratePercent: 1.75, feeCents: 368 },
    { baseCents: 21000, ratePercent: 2.9, feeCents: 609 },
    { baseCents: 10000, ratePercent: 1.5, feeCents: 150 },
    { baseCents: 10000, ratePercent: 100, feeCents: 10000 },
    { baseCents: 1, ratePercent: 1.5, feeCents: 0 },
    { baseCents: 1, ratePercent: 100, feeCents: 1 },
    { baseCents: 33, ratePercent: 1.5, feeCents: 0 },
    { baseCents: 34, ratePercent: 1.5, feeCents: 1 },
    { baseCents: 100, ratePercent: 1.5, feeCents: 2 },
    { baseCents: 3333, ratePercent: 1.5, feeCents: 50 },
    { baseCents: 3333, ratePercent: 0.5, feeCents: 17 },
    { baseCents: 1999, ratePercent: 1.5, feeCents: 30 },
    { baseCents: 1999, ratePercent: 1.75, feeCents: 35 },
    { baseCents: 123456, ratePercent: 1.5, feeCents: 1852 },
    { baseCents: 123456, ratePercent: 2, feeCents: 2469 },
    { baseCents: 123456, ratePercent: 3.4, feeCents: 4198 },
    { baseCents: 9999, ratePercent: 1.5, feeCents: 150 },
    { baseCents: 4995, ratePercent: 1.75, feeCents: 87 },
    { baseCents: 6667, ratePercent: 1.5, feeCents: 100 },
    { baseCents: 1337, ratePercent: 2, feeCents: 27 },
    { baseCents: 250, ratePercent: 1.75, feeCents: 4 },
    { baseCents: 250, ratePercent: 3.4, feeCents: 9 },
    { baseCents: 100000001, ratePercent: 1.5, feeCents: 1500000 },
  ])(
    "computeFeeCents($baseCents, $ratePercent) = $feeCents",
    ({ baseCents, ratePercent, feeCents }) => {
      expect(computeFeeCents(baseCents, ratePercent)).toBe(feeCents);
    },
  );

  it("takes the base net of the fee line, as checkout-prices does (213.15 with a 3.15 fee line)", () => {
    // checkout-prices src/pages/api/payment-fee.ts: base = toCents(total) - Σ toCents(fee lines)
    const baseCents = toCents(213.15) - toCents(3.15);

    expect(baseCents).toBe(21000);
    expect(computeFeeCents(baseCents, 1.5)).toBe(315);
  });
});
