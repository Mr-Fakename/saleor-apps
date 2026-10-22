import { describe, expect, it } from "vitest";

import { CheckoutPaymentStateTransaction } from "./checkout-payment-state-fetcher";
import { hasRecordedMoneyMovement } from "./recorded-money-movement";

const eur = (amount: number) => ({ amount, currency: "EUR" });

const transaction = (
  overrides: Partial<CheckoutPaymentStateTransaction> = {},
): CheckoutPaymentStateTransaction => ({
  id: "VHJhbnNhY3Rpb25JdGVtOjE=",
  pspReference: "pi_1",
  chargedAmount: eur(0),
  authorizedAmount: eur(0),
  chargePendingAmount: eur(0),
  authorizePendingAmount: eur(0),
  refundedAmount: eur(0),
  refundPendingAmount: eur(0),
  canceledAmount: eur(0),
  cancelPendingAmount: eur(0),
  events: [],
  ...overrides,
});

describe("hasRecordedMoneyMovement (review M2)", () => {
  it("is false for a transaction Saleor has recorded no money on", () => {
    expect(hasRecordedMoneyMovement(transaction())).toBe(false);
  });

  it.each([
    "chargedAmount",
    "authorizedAmount",
    "chargePendingAmount",
    "authorizePendingAmount",
    "refundedAmount",
    "refundPendingAmount",
    "canceledAmount",
    "cancelPendingAmount",
  ] as const)("is true when %s is above 0", (field) => {
    expect(hasRecordedMoneyMovement(transaction({ [field]: eur(0.01) }))).toBe(true);
  });

  it.each([
    "AUTHORIZATION_SUCCESS",
    "AUTHORIZATION_ADJUSTMENT",
    "CHARGE_SUCCESS",
    "CHARGE_BACK",
    "REFUND_SUCCESS",
    "REFUND_REVERSE",
    "CANCEL_SUCCESS",
  ] as const)("is true with a %s event, even when every amount is back to 0", (type) => {
    expect(hasRecordedMoneyMovement(transaction({ events: [{ type }] }))).toBe(true);
  });

  it.each([
    "AUTHORIZATION_REQUEST",
    "AUTHORIZATION_FAILURE",
    "AUTHORIZATION_ACTION_REQUIRED",
    "CHARGE_REQUEST",
    "CHARGE_FAILURE",
    "CHARGE_ACTION_REQUIRED",
    "REFUND_REQUEST",
    "REFUND_FAILURE",
    "CANCEL_REQUEST",
    "CANCEL_FAILURE",
    "INFO",
  ] as const)("is false with only a %s event (no money moved)", (type) => {
    expect(hasRecordedMoneyMovement(transaction({ events: [{ type }, { type: null }] }))).toBe(
      false,
    );
  });
});
