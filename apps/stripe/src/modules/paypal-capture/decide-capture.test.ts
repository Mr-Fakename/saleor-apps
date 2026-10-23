import { describe, expect, it } from "vitest";

import {
  AUTHORIZATION_RECORD_GRACE_MS,
  CAPTURE_HOLD_REASONS,
  CaptureDecision,
  CaptureOrder,
  CaptureOrderLine,
  CaptureOrderTransaction,
  CapturePaymentIntent,
  CaptureRecord,
  CaptureTransaction,
  decideCapture,
} from "./decide-capture";

/*
 * A3d capture rule (docs/plans/2026-10-22-paypal-fee-gate-design.md §9). The worker captures a
 * paypal-only authorization only once its Saleor transaction sits on an ORDER that passes every
 * rule below; first match wins. Anything else is held for staff (never a smaller capture, OD2),
 * except a CANCELED order, which is released (OD1).
 *
 * Fixture: base 100.00 EUR, PayPal fee 1.5 % = 1.50, total 101.50.
 */

const FEE_VARIANT_ID = "UHJvZHVjdFZhcmlhbnQ6NDQ5";
const PRODUCT_VARIANT_ID = "UHJvZHVjdFZhcmlhbnQ6MTI=";
const PI_ID = "pi_3A3dDecide";
const TX_ID = "VHJhbnNhY3Rpb25JdGVtOjQy";
const OTHER_TX_ID = "VHJhbnNhY3Rpb25JdGVtOjQx";
const ORDER_ID = "T3JkZXI6YTNk";
const CHECKOUT_ID = "Q2hlY2tvdXQ6YTNk";

const GATE = { ratePercent: 1.5, variantId: FEE_VARIANT_ID, metadataKey: "payment_fee_type" };

const eur = (amount: number) => ({ amount, currency: "EUR" });

const paymentIntent = (overrides: Partial<CapturePaymentIntent> = {}): CapturePaymentIntent => ({
  id: PI_ID,
  status: "requires_capture",
  amount: 101_50,
  amount_capturable: 101_50,
  amount_received: 0,
  currency: "eur",
  // Spike S1: the PayPal option carries the manual capture; top-level stays automatic_async.
  capture_method: "automatic_async",
  payment_method_options: { paypal: { capture_method: "manual" } } as CapturePaymentIntent["payment_method_options"],
  payment_method_types: ["paypal"],
  excluded_payment_method_types: null,
  automatic_payment_methods: null,
  ...overrides,
  metadata: {
    saleor_source_id: CHECKOUT_ID,
    saleor_source_type: "Checkout",
    saleor_transaction_id: TX_ID,
    saleor_payment_policy: "paypal-only",
    ...overrides.metadata,
  },
});

const record = (overrides: Partial<CaptureRecord> = {}): CaptureRecord => ({
  saleorTransactionId: TX_ID,
  stripePaymentIntentId: PI_ID,
  saleorTransactionFlow: "CHARGE",
  ...overrides,
});

// Without an order-level discount the own price (undiscountedTotalPrice) equals the total.
const productLine = (amount: number, overrides: Partial<CaptureOrderLine> = {}): CaptureOrderLine => {
  const totalPrice = overrides.totalPrice ?? { gross: eur(amount) };

  return {
    productVariantId: PRODUCT_VARIANT_ID,
    quantity: 1,
    metadata: [],
    totalPrice,
    undiscountedTotalPrice: totalPrice,
    ...overrides,
  };
};

const feeLine = (amount: number, overrides: Partial<CaptureOrderLine> = {}): CaptureOrderLine => {
  const totalPrice = overrides.totalPrice ?? { gross: eur(amount) };

  return {
    productVariantId: FEE_VARIANT_ID,
    quantity: 1,
    metadata: [{ key: "payment_fee_type", value: "paypal_1.5_percent" }],
    totalPrice,
    undiscountedTotalPrice: totalPrice,
    ...overrides,
  };
};

/** Order lines of case A12: a 10 % ENTIRE_ORDER voucher spread over the product and the fee. */
const voucheredLines = (fee: { own: number; discounted: number }): CaptureOrderLine[] => [
  productLine(84.69, { undiscountedTotalPrice: { gross: eur(94.1) } }),
  feeLine(fee.discounted, { undiscountedTotalPrice: { gross: eur(fee.own) } }),
];

const orderTransaction = (overrides: Partial<CaptureOrderTransaction> = {}): CaptureOrderTransaction => ({
  id: TX_ID,
  authorizedAmount: eur(101.5),
  chargedAmount: eur(0),
  authorizePendingAmount: eur(0),
  chargePendingAmount: eur(0),
  ...overrides,
});

const order = (overrides: Partial<CaptureOrder> = {}): CaptureOrder => ({
  id: ORDER_ID,
  number: "1201",
  status: "UNFULFILLED",
  total: { gross: eur(101.5) },
  lines: [productLine(100), feeLine(1.5)],
  transactions: [orderTransaction()],
  payments: [],
  ...overrides,
});

const transaction = (overrides: Partial<CaptureTransaction> = {}): CaptureTransaction => ({
  id: TX_ID,
  pspReference: PI_ID,
  metadata: [{ key: "stripe_payment_policy", value: "paypal-only" }],
  authorizedAmount: eur(101.5),
  chargedAmount: eur(0),
  refundedAmount: eur(0),
  canceledAmount: eur(0),
  authorizePendingAmount: eur(0),
  chargePendingAmount: eur(0),
  refundPendingAmount: eur(0),
  cancelPendingAmount: eur(0),
  checkout: null,
  order: order(),
  ...overrides,
});

const decide = (args: {
  paymentIntent?: CapturePaymentIntent;
  record?: CaptureRecord | null;
  transaction?: CaptureTransaction | null;
}): CaptureDecision =>
  decideCapture({
    paymentIntent: args.paymentIntent ?? paymentIntent(),
    record: args.record === undefined ? record() : args.record,
    transaction: args.transaction === undefined ? transaction() : args.transaction,
    gate: GATE,
  });

const CAPTURE = { outcome: "capture", rule: "R13", amount: 101.5, currency: "EUR" } as const;

describe("decideCapture (A3d)", () => {
  it("captures the order total when every rule passes", () => {
    expect(decide({})).toStrictEqual(CAPTURE);
  });

  describe("R0 status: only an authorization waiting for capture", () => {
    it.each(["succeeded", "canceled", "processing", "requires_payment_method", "requires_action"] as const)(
      "skips a %s PaymentIntent",
      (status) => {
        expect(decide({ paymentIntent: paymentIntent({ status }) })).toStrictEqual({
          outcome: "skip",
          rule: "R0",
          reason: "not-requires-capture",
        });
      },
    );
  });

  describe("R1 policy: only paypal-only PaymentIntents", () => {
    it("skips a PaymentIntent without a policy (created with the gate off)", () => {
      const pi = paymentIntent({
        metadata: { saleor_payment_policy: "" },
        payment_method_types: ["card", "paypal"],
        automatic_payment_methods: { enabled: true, allow_redirects: "always" },
      });

      expect(decide({ paymentIntent: pi })).toStrictEqual({ outcome: "skip", rule: "R1", reason: "not-paypal-only" });
    });

    it("skips a no-paypal PaymentIntent (card authorizations are staff-captured, unchanged)", () => {
      const pi = paymentIntent({
        metadata: { saleor_payment_policy: "no-paypal" },
        payment_method_types: ["card"],
        excluded_payment_method_types: ["paypal"],
        automatic_payment_methods: { enabled: true, allow_redirects: "always" },
      });

      expect(decide({ paymentIntent: pi })).toStrictEqual({ outcome: "skip", rule: "R1", reason: "not-paypal-only" });
    });

    it("holds a PaymentIntent tagged paypal-only whose live methods disagree", () => {
      const pi = paymentIntent({ payment_method_types: ["card", "paypal"] });

      expect(decide({ paymentIntent: pi })).toMatchObject({ outcome: "hold", rule: "R1", reason: "policy-inconsistent" });
    });
  });

  describe("R2 capture method", () => {
    it("skips a PaymentIntent that was not created for a manual capture", () => {
      const pi = paymentIntent({
        payment_method_options: { paypal: {} } as CapturePaymentIntent["payment_method_options"],
      });

      expect(decide({ paymentIntent: pi })).toStrictEqual({ outcome: "skip", rule: "R2", reason: "not-manual-capture" });
    });

    it("accepts a top-level manual capture", () => {
      const pi = paymentIntent({ capture_method: "manual", payment_method_options: null });

      expect(decide({ paymentIntent: pi })).toStrictEqual(CAPTURE);
    });
  });

  describe("R3 link: DynamoDB record, PaymentIntent and Saleor transaction agree", () => {
    it("skips a PaymentIntent this installation never recorded", () => {
      expect(decide({ record: null })).toStrictEqual({ outcome: "skip", rule: "R3", reason: "not-recorded" });
    });

    it("skips an AUTHORIZATION-flow transaction: staff capture it by design", () => {
      expect(decide({ record: record({ saleorTransactionFlow: "AUTHORIZATION" }) })).toStrictEqual({
        outcome: "skip",
        rule: "R3",
        reason: "authorization-flow",
      });
    });

    it("skips when Saleor has no such transaction", () => {
      expect(decide({ transaction: null })).toStrictEqual({ outcome: "skip", rule: "R3", reason: "transaction-not-found" });
    });

    it.each<{ case: string; args: Parameters<typeof decide>[0] }>([
      { case: "the record names another PaymentIntent", args: { record: record({ stripePaymentIntentId: "pi_other" }) } },
      {
        case: "the PaymentIntent names another transaction",
        args: { paymentIntent: paymentIntent({ metadata: { saleor_transaction_id: OTHER_TX_ID } }) },
      },
      { case: "the transaction holds another pspReference", args: { transaction: transaction({ pspReference: "pi_other" }) } },
      { case: "the record names another transaction", args: { record: record({ saleorTransactionId: OTHER_TX_ID }) } },
    ])("holds when $case", ({ args }) => {
      expect(decide(args)).toMatchObject({ outcome: "hold", rule: "R3", reason: "link-mismatch" });
    });
  });

  describe("R4 policy tag on the Saleor transaction", () => {
    it.each<{ case: string; metadata: CaptureTransaction["metadata"] }>([
      { case: "missing", metadata: [] },
      { case: "no-paypal", metadata: [{ key: "stripe_payment_policy", value: "no-paypal" }] },
    ])("holds when the tag is $case", ({ metadata }) => {
      expect(decide({ transaction: transaction({ metadata }) })).toMatchObject({
        outcome: "hold",
        rule: "R4",
        reason: "policy-tag",
      });
    });
  });

  describe("R5 capture state tag", () => {
    it("skips a transaction already held for staff: the worker never captures it", () => {
      const metadata = [
        { key: "stripe_payment_policy", value: "paypal-only" },
        { key: "stripe_capture_state", value: "held" },
        { key: "stripe_capture_hold_reason", value: "fee-absent" },
      ];

      expect(decide({ transaction: transaction({ metadata }) })).toStrictEqual({
        outcome: "skip",
        rule: "R5",
        reason: "already-held",
      });
    });
  });

  describe("R6 order present", () => {
    it("waits while the transaction is still on the checkout (completion pending)", () => {
      expect(decide({ transaction: transaction({ order: null, checkout: { id: CHECKOUT_ID } }) })).toStrictEqual({
        outcome: "wait",
        rule: "R6",
        reason: "checkout-not-completed",
      });
    });

    it("holds a transaction on neither a checkout nor an order", () => {
      expect(decide({ transaction: transaction({ order: null, checkout: null }) })).toMatchObject({
        outcome: "hold",
        rule: "R6",
        reason: "order-missing",
      });
    });
  });

  describe("R7 order status", () => {
    it("releases the authorization of a CANCELED order (OD1)", () => {
      expect(decide({ transaction: transaction({ order: order({ status: "CANCELED" }) }) })).toStrictEqual({
        outcome: "release",
        rule: "R7",
      });
    });

    it.each<{ case: string; metadata: CaptureTransaction["metadata"] }>([
      { case: "without the policy tag (R4)", metadata: [] },
      {
        case: "already held (R5)",
        metadata: [
          { key: "stripe_payment_policy", value: "paypal-only" },
          { key: "stripe_capture_state", value: "held" },
        ],
      },
    ])("releases a CANCELED order's authorization even $case: tags never block OD1", ({ metadata }) => {
      expect(
        decide({ transaction: transaction({ metadata, order: order({ status: "CANCELED" }) }) }),
      ).toStrictEqual({ outcome: "release", rule: "R7" });
    });

    it("waits while the order is UNCONFIRMED (staff can still edit its lines)", () => {
      expect(decide({ transaction: transaction({ order: order({ status: "UNCONFIRMED" }) }) })).toStrictEqual({
        outcome: "wait",
        rule: "R7",
        reason: "order-unconfirmed",
      });
    });

    it.each(["DRAFT", "EXPIRED", "RETURNED", "PARTIALLY_RETURNED", "SOMETHING_NEW"])("holds a %s order", (status) => {
      expect(decide({ transaction: transaction({ order: order({ status }) }) })).toMatchObject({
        outcome: "hold",
        rule: "R7",
        reason: "order-status",
      });
    });

    it.each(["UNFULFILLED", "PARTIALLY_FULFILLED", "FULFILLED"])("captures a %s order", (status) => {
      expect(decide({ transaction: transaction({ order: order({ status }) }) })).toStrictEqual(CAPTURE);
    });
  });

  describe("R8 nothing pending on the transaction", () => {
    it.each([
      "authorizePendingAmount",
      "chargePendingAmount",
      "refundPendingAmount",
      "cancelPendingAmount",
    ] as const)("waits while %s > 0", (field) => {
      expect(decide({ transaction: transaction({ [field]: eur(1) }) })).toStrictEqual({
        outcome: "wait",
        rule: "R8",
        reason: "pending",
      });
    });
  });

  describe("R9 ledger: Saleor holds exactly this authorization", () => {
    it("waits while Saleor has not recorded the authorization yet", () => {
      expect(decide({ transaction: transaction({ authorizedAmount: eur(0) }) })).toStrictEqual({
        outcome: "wait",
        rule: "R9",
        reason: "authorization-not-recorded",
      });
    });

    describe("never recorded (review P2): a wait longer than 30 min is held", () => {
      const FIRST_CHECK = Date.parse("2026-10-23T10:00:00.000Z");
      const unrecorded = () => transaction({ authorizedAmount: eur(0) });
      const decideAt = (elapsedMs: number) =>
        decideCapture({
          paymentIntent: paymentIntent(),
          record: record(),
          transaction: unrecorded(),
          gate: GATE,
          authorizationWait: { firstCheckedAtMs: FIRST_CHECK, nowMs: FIRST_CHECK + elapsedMs },
        });

      it("is 30 min", () => {
        expect(AUTHORIZATION_RECORD_GRACE_MS).toBe(30 * 60_000);
      });

      it("still waits just before 30 min", () => {
        expect(decideAt(AUTHORIZATION_RECORD_GRACE_MS - 1)).toStrictEqual({
          outcome: "wait",
          rule: "R9",
          reason: "authorization-not-recorded",
        });
      });

      it.each([AUTHORIZATION_RECORD_GRACE_MS, 2 * AUTHORIZATION_RECORD_GRACE_MS])(
        "holds after %i ms",
        (elapsedMs) => {
          expect(decideAt(elapsedMs)).toMatchObject({
            outcome: "hold",
            rule: "R9",
            reason: "authorization-not-recorded",
          });
        },
      );

      it("only for a transaction with nothing recorded: a recorded one is unaffected", () => {
        expect(
          decideCapture({
            paymentIntent: paymentIntent(),
            record: record(),
            transaction: transaction(),
            gate: GATE,
            authorizationWait: { firstCheckedAtMs: FIRST_CHECK, nowMs: FIRST_CHECK + 3 * AUTHORIZATION_RECORD_GRACE_MS },
          }),
        ).toStrictEqual(CAPTURE);
      });

      it("is a hold reason the tag may carry", () => {
        expect(CAPTURE_HOLD_REASONS).toContain("authorization-not-recorded");
      });
    });

    it.each<{ case: string; args: Parameters<typeof decide>[0] }>([
      { case: "Saleor counts less than Stripe holds", args: { transaction: transaction({ authorizedAmount: eur(100) }) } },
      { case: "Saleor counts more than Stripe holds", args: { transaction: transaction({ authorizedAmount: eur(102) }) } },
      {
        case: "something was already charged",
        args: { transaction: transaction({ authorizedAmount: eur(1.5), chargedAmount: eur(100) }) },
      },
      { case: "something was refunded", args: { transaction: transaction({ refundedAmount: eur(1) }) } },
      { case: "something was canceled", args: { transaction: transaction({ canceledAmount: eur(1) }) } },
      { case: "Stripe holds less than the amount", args: { paymentIntent: paymentIntent({ amount_capturable: 100_00 }) } },
    ])("holds when $case", ({ args }) => {
      expect(decide(args)).toMatchObject({ outcome: "hold", rule: "R9", reason: "ledger-mismatch" });
    });
  });

  describe("R10 one payment only", () => {
    it.each<{ case: string; other: Partial<CaptureOrderTransaction> }>([
      { case: "charged", other: { chargedAmount: eur(10) } },
      { case: "authorized", other: { authorizedAmount: eur(10) } },
      { case: "authorization pending", other: { authorizePendingAmount: eur(10) } },
      { case: "charge pending", other: { chargePendingAmount: eur(10) } },
    ])("holds when another transaction of the order holds money ($case)", ({ other }) => {
      const transactions = [
        orderTransaction(),
        orderTransaction({ id: OTHER_TX_ID, authorizedAmount: eur(0), ...other }),
      ];

      expect(decide({ transaction: transaction({ order: order({ transactions }) }) })).toMatchObject({
        outcome: "hold",
        rule: "R10",
        reason: "other-payments",
      });
    });

    it("holds when the order has an active legacy payment", () => {
      expect(
        decide({ transaction: transaction({ order: order({ payments: [{ id: "UGF5bWVudDox", isActive: true }] }) }) }),
      ).toMatchObject({ outcome: "hold", rule: "R10", reason: "other-payments" });
    });

    it("captures when the other transactions are empty attempts", () => {
      const transactions = [orderTransaction(), orderTransaction({ id: OTHER_TX_ID, authorizedAmount: eur(0) })];
      const payments = [{ id: "UGF5bWVudDox", isActive: false }];

      expect(decide({ transaction: transaction({ order: order({ transactions, payments }) }) })).toStrictEqual(CAPTURE);
    });
  });

  describe("R11 currency", () => {
    it("holds when the PaymentIntent currency differs from Saleor's", () => {
      expect(decide({ paymentIntent: paymentIntent({ currency: "usd" }) })).toMatchObject({
        outcome: "hold",
        rule: "R11",
        reason: "currency-mismatch",
      });
    });

    it("holds when the order total is in another currency", () => {
      const usdOrder = order({ total: { gross: { amount: 101.5, currency: "USD" } } });

      expect(decide({ transaction: transaction({ order: usdOrder }) })).toMatchObject({
        outcome: "hold",
        rule: "R11",
        reason: "currency-mismatch",
      });
    });

    it("holds a currency without 2 decimals (the fee rule is defined in cents)", () => {
      const jpy = (amount: number) => ({ amount, currency: "JPY" });
      const pi = paymentIntent({ currency: "jpy", amount: 10150, amount_capturable: 10150 });
      const tx = transaction({
        authorizedAmount: jpy(10150),
        chargedAmount: jpy(0),
        refundedAmount: jpy(0),
        canceledAmount: jpy(0),
        authorizePendingAmount: jpy(0),
        chargePendingAmount: jpy(0),
        refundPendingAmount: jpy(0),
        cancelPendingAmount: jpy(0),
        order: order({
          total: { gross: jpy(10150) },
          lines: [productLine(0, { totalPrice: { gross: jpy(10000) } }), feeLine(0, { totalPrice: { gross: jpy(150) } })],
          transactions: [orderTransaction({ authorizedAmount: jpy(10150), chargedAmount: jpy(0), authorizePendingAmount: jpy(0), chargePendingAmount: jpy(0) })],
        }),
      });

      expect(decide({ paymentIntent: pi, transaction: tx })).toMatchObject({
        outcome: "hold",
        rule: "R11",
        reason: "currency-mismatch",
      });
    });
  });

  describe("R12 PayPal fee on the ORDER lines (productVariantId, not variant)", () => {
    it("TAMPER: fee line deleted and a same-priced item added before approval -> fee-absent", () => {
      // The shopper swapped the 1.50 fee for a 1.50 product: totals still match the authorization.
      const lines = [productLine(100), productLine(1.5, { productVariantId: "UHJvZHVjdFZhcmlhbnQ6OTk=" })];

      expect(decide({ transaction: transaction({ order: order({ lines }) }) })).toMatchObject({
        outcome: "hold",
        rule: "R12",
        reason: "fee-absent",
      });
    });

    it("fee line deleted and nothing added: the authorization exceeds the order by exactly the fee -> overcharge-by-fee", () => {
      const tamperedOrder = order({ lines: [productLine(100)], total: { gross: eur(100) } });

      expect(decide({ transaction: transaction({ order: tamperedOrder }) })).toMatchObject({
        outcome: "hold",
        rule: "R12",
        reason: "overcharge-by-fee",
      });
    });

    it("fee absent and the difference is not the fee -> fee-absent", () => {
      const otherOrder = order({ lines: [productLine(99)], total: { gross: eur(99) } });

      expect(decide({ transaction: transaction({ order: otherOrder }) })).toMatchObject({
        outcome: "hold",
        rule: "R12",
        reason: "fee-absent",
      });
    });

    it.each<{ case: string; lines: CaptureOrderLine[]; total: number }>([
      { case: "a stale fee amount", lines: [productLine(100.1), feeLine(1.4)], total: 101.5 },
      { case: "the fee marker forged onto a product line", lines: [productLine(100), productLine(1.5, { metadata: [{ key: "payment_fee_type", value: "x" }] })], total: 101.5 },
      { case: "two fee lines", lines: [productLine(98.5), feeLine(1.5), feeLine(1.5)], total: 101.5 },
      { case: "a fee line whose variant was deleted (productVariantId null)", lines: [productLine(100), feeLine(1.5, { productVariantId: null })], total: 101.5 },
      { case: "a fee quantity of 2", lines: [productLine(98.5), feeLine(3, { quantity: 2 })], total: 101.5 },
    ])("holds $case -> fee-invalid", ({ lines, total }) => {
      expect(decide({ transaction: transaction({ order: order({ lines, total: { gross: eur(total) } }) }) })).toMatchObject({
        outcome: "hold",
        rule: "R12",
        reason: "fee-invalid",
      });
    });

    describe("with an order-level voucher spread over the fee line (A12)", () => {
      it("A12: own 1.36 = the fee on the base 90.59, discounted 1.22, order 91.81 authorized -> capture", () => {
        const pi = paymentIntent({ amount: 91_81, amount_capturable: 91_81 });
        const tx = transaction({
          authorizedAmount: eur(91.81),
          order: order({
            total: { gross: eur(91.81) },
            lines: voucheredLines({ own: 1.36, discounted: 1.22 }),
            transactions: [orderTransaction({ authorizedAmount: eur(91.81) })],
          }),
        });

        expect(decide({ paymentIntent: pi, transaction: tx })).toStrictEqual({
          outcome: "capture",
          rule: "R13",
          amount: 91.81,
          currency: "EUR",
        });
      });

      it("A12b: voucher added after initialize (authorized 101.50, order 91.94, own 1.50 / discounted 1.35) -> still a hold", () => {
        const tx = transaction({
          order: order({ total: { gross: eur(91.94) }, lines: voucheredLines({ own: 1.5, discounted: 1.35 }) }),
        });

        expect(decide({ transaction: tx })).toStrictEqual({
          outcome: "hold",
          rule: "R12",
          reason: "fee-invalid",
          detail: { feeReason: "amount-mismatch", expectedFeeCents: 136, ownFeeCents: 150, lineFeeCents: 135 },
        });
      });

      it("holds a fee line whose discounted total is above its own price -> fee-invalid", () => {
        const pi = paymentIntent({ amount: 92_09, amount_capturable: 92_09 });
        const tx = transaction({
          authorizedAmount: eur(92.09),
          order: order({
            total: { gross: eur(92.09) },
            lines: voucheredLines({ own: 1.36, discounted: 1.5 }),
            transactions: [orderTransaction({ authorizedAmount: eur(92.09) })],
          }),
        });

        expect(decide({ paymentIntent: pi, transaction: tx })).toMatchObject({
          outcome: "hold",
          rule: "R12",
          reason: "fee-invalid",
          detail: { feeReason: "discounted-total-out-of-range" },
        });
      });
    });
  });

  describe("R13 order total = PaymentIntent amount", () => {
    it("holds when the authorization is larger than the order with a valid fee (never a smaller capture, OD2)", () => {
      const pi = paymentIntent({ amount: 102_00, amount_capturable: 102_00 });

      expect(decide({ paymentIntent: pi, transaction: transaction({ authorizedAmount: eur(102) }) })).toMatchObject({
        outcome: "hold",
        rule: "R13",
        reason: "amount-mismatch",
      });
    });

    it("holds when the authorization is smaller than the order", () => {
      const pi = paymentIntent({ amount: 101_00, amount_capturable: 101_00 });

      expect(decide({ paymentIntent: pi, transaction: transaction({ authorizedAmount: eur(101) }) })).toMatchObject({
        outcome: "hold",
        rule: "R13",
        reason: "amount-mismatch",
      });
    });
  });

  describe("first match wins", () => {
    it("R1 before R7: an inconsistent PaymentIntent is held even on a CANCELED order", () => {
      const pi = paymentIntent({ payment_method_types: ["card", "paypal"] });

      expect(decide({ paymentIntent: pi, transaction: transaction({ order: order({ status: "CANCELED" }) }) })).toMatchObject({
        outcome: "hold",
        rule: "R1",
      });
    });

    it("R3 before R7: a link mismatch is held even on a CANCELED order", () => {
      expect(
        decide({ transaction: transaction({ pspReference: "pi_other", order: order({ status: "CANCELED" }) }) }),
      ).toMatchObject({ outcome: "hold", rule: "R3" });
    });

    it("R8 before R12: a pending action waits even when the fee is absent", () => {
      expect(
        decide({ transaction: transaction({ chargePendingAmount: eur(1), order: order({ lines: [productLine(101.5)] }) }) }),
      ).toMatchObject({ outcome: "wait", rule: "R8" });
    });
  });
});
