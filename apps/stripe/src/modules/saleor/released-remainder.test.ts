import { describe, expect, it } from "vitest";

import { mockedSaleorTransactionId } from "@/__tests__/mocks/constants";

import {
  createReleasedRemainderPspReference,
  resolveReleasedRemainderReport,
} from "./released-remainder";

/*
 * Spike S2 (sandbox, 2026-10-23): after a partial capture of 60 on an authorization of 100,
 * Stripe releases the other 40, sends no refund.* event, and Saleor 3.22.74 still shows 40
 * "authorized" (payment/transaction_item_calculations.py _recalculate_charge_amounts subtracts
 * only the CHARGE_SUCCESS amount). A CANCEL_SUCCESS of 40 under its own pspReference moves the
 * 40 from authorizedAmount to canceledAmount (_recalculate_cancel_amounts).
 */

const TIME = new Date("2026-10-23T09:00:00.000Z");

const paymentIntent = (overrides: { status?: string; amount?: number; amount_received?: number; currency?: string } = {}) => ({
  id: "pi_3S2Partial",
  status: "succeeded",
  amount: 100_00,
  amount_received: 60_00,
  currency: "eur",
  ...overrides,
});

describe("createReleasedRemainderPspReference", () => {
  it("is the PaymentIntent id with the :released suffix, never the PaymentIntent id itself", () => {
    expect(createReleasedRemainderPspReference("pi_3S2Partial")).toBe("pi_3S2Partial:released");
  });
});

describe("resolveReleasedRemainderReport", () => {
  it("reports CANCEL_SUCCESS for amount - amount_received under <pi>:released", () => {
    const report = resolveReleasedRemainderReport({
      paymentIntent: paymentIntent(),
      saleorTransactionId: mockedSaleorTransactionId,
      time: TIME,
      stripeEnv: "TEST",
    })._unsafeUnwrap();

    expect(report).toStrictEqual({
      transactionId: mockedSaleorTransactionId,
      type: "CANCEL_SUCCESS",
      amount: expect.objectContaining({ amount: 40, currency: "EUR" }),
      pspReference: "pi_3S2Partial:released",
      message: "Uncaptured remainder released by Stripe after a partial capture",
      time: TIME.toISOString(),
      // null: Saleor keeps the actions the charge answer set ([REFUND]).
      actions: null,
      externalUrl: "https://dashboard.stripe.com/test/payments/pi_3S2Partial",
    });
  });

  it("is deterministic: the same PaymentIntent always gives the same report (Saleor de-duplicates it)", () => {
    const args = {
      paymentIntent: paymentIntent(),
      saleorTransactionId: mockedSaleorTransactionId,
      time: TIME,
      stripeEnv: "LIVE" as const,
    };

    expect(resolveReleasedRemainderReport(args)._unsafeUnwrap()).toStrictEqual(
      resolveReleasedRemainderReport(args)._unsafeUnwrap(),
    );
  });

  it.each<{ case: string; pi: Parameters<typeof paymentIntent>[0] }>([
    { case: "a full capture", pi: { amount_received: 100_00 } },
    { case: "more received than the amount (test fixtures)", pi: { amount_received: 101_00 } },
    { case: "a PaymentIntent still authorized", pi: { status: "requires_capture", amount_received: 0 } },
    { case: "a canceled PaymentIntent", pi: { status: "canceled", amount_received: 0 } },
    { case: "a processing PaymentIntent", pi: { status: "processing" } },
  ])("reports nothing for $case", ({ pi }) => {
    expect(
      resolveReleasedRemainderReport({
        paymentIntent: paymentIntent(pi),
        saleorTransactionId: mockedSaleorTransactionId,
        time: TIME,
        stripeEnv: "TEST",
      })._unsafeUnwrap(),
    ).toBeNull();
  });

  it("converts minor units with the currency's decimals", () => {
    const report = resolveReleasedRemainderReport({
      paymentIntent: paymentIntent({ currency: "jpy", amount: 10_000, amount_received: 6_000 }),
      saleorTransactionId: mockedSaleorTransactionId,
      time: TIME,
      stripeEnv: "TEST",
    })._unsafeUnwrap();

    expect(report?.amount).toStrictEqual(expect.objectContaining({ amount: 4000, currency: "JPY" }));
  });
});
