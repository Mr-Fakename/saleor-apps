import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import {
  decideInitializePolicy,
  decideUpdatePolicy,
  PAYMENT_POLICY_METADATA_KEY,
  PaymentIntentPolicyReading,
  paymentIntentHasPolicy,
  readPaymentIntentPolicy,
} from "./payment-method-policy";
import { PaymentFeeState } from "./verify-payment-fee";

const ABSENT: PaymentFeeState = { status: "ABSENT" };
const VALID: PaymentFeeState = { status: "VALID", baseCents: 21000, feeCents: 315 };
const INVALID: PaymentFeeState = { status: "INVALID", reason: "amount-mismatch" };

type PolicyFields = Pick<
  Stripe.PaymentIntent,
  "metadata" | "payment_method_types" | "excluded_payment_method_types" | "automatic_payment_methods"
>;

const paypalOnly = (overrides: Partial<PolicyFields> = {}): PolicyFields => ({
  metadata: { [PAYMENT_POLICY_METADATA_KEY]: "paypal-only" },
  payment_method_types: ["paypal"],
  excluded_payment_method_types: null,
  automatic_payment_methods: null,
  ...overrides,
});

const noPaypal = (overrides: Partial<PolicyFields> = {}): PolicyFields => ({
  metadata: { [PAYMENT_POLICY_METADATA_KEY]: "no-paypal" },
  // As Stripe returned it in the sandbox (S0).
  payment_method_types: ["card", "bancontact", "eps", "ideal", "sepa_debit", "klarna", "link"],
  excluded_payment_method_types: ["paypal"],
  automatic_payment_methods: { enabled: true, allow_redirects: "always" },
  ...overrides,
});

const legacy = (): PolicyFields => ({
  metadata: { saleor_source_id: "Q2hlY2tvdXQ6MQ==", saleor_source_type: "Checkout" },
  payment_method_types: ["card", "paypal", "klarna"],
  excluded_payment_method_types: null,
  automatic_payment_methods: { enabled: true, allow_redirects: "always" },
});

describe("payment-method policy (A3c)", () => {
  describe("§2b transactionInitialize decision", () => {
    it.each<{
      paymentMethod: string;
      paymentFee: PaymentFeeState;
      expected: ReturnType<typeof decideInitializePolicy>;
    }>([
      { paymentMethod: "paypal", paymentFee: ABSENT, expected: { outcome: "refused", cause: "fee-required" } },
      { paymentMethod: "paypal", paymentFee: VALID, expected: { outcome: "allowed", policy: "paypal-only" } },
      { paymentMethod: "paypal", paymentFee: INVALID, expected: { outcome: "refused", cause: "fee-stale" } },
      { paymentMethod: "card", paymentFee: ABSENT, expected: { outcome: "allowed", policy: "no-paypal" } },
      { paymentMethod: "card", paymentFee: VALID, expected: { outcome: "refused", cause: "fee-present" } },
      { paymentMethod: "card", paymentFee: INVALID, expected: { outcome: "refused", cause: "fee-present" } },
      { paymentMethod: "klarna", paymentFee: ABSENT, expected: { outcome: "allowed", policy: "no-paypal" } },
      { paymentMethod: "klarna", paymentFee: VALID, expected: { outcome: "refused", cause: "fee-present" } },
      { paymentMethod: "apple_pay", paymentFee: INVALID, expected: { outcome: "refused", cause: "fee-present" } },
    ])("$paymentMethod with fee $paymentFee.status -> $expected.outcome", ({ paymentMethod, paymentFee, expected }) => {
      expect(decideInitializePolicy({ paymentMethod, paymentFee })).toStrictEqual(expected);
    });

    it.each<{ paymentMethod: string; expected: ReturnType<typeof decideInitializePolicy> }>([
      { paymentMethod: "paypal", expected: { outcome: "refused", cause: "fee-required" } },
      { paymentMethod: "card", expected: { outcome: "allowed", policy: "no-paypal" } },
      { paymentMethod: "sepa_debit", expected: { outcome: "allowed", policy: "no-paypal" } },
    ])(
      "Order source (no checkout fee to verify): $paymentMethod -> $expected.outcome",
      ({ paymentMethod, expected }) => {
        expect(decideInitializePolicy({ paymentMethod, paymentFee: null })).toStrictEqual(expected);
      },
    );
  });

  describe("§2c update-payment-intent decision", () => {
    const POLICY = (policy: "paypal-only" | "no-paypal"): PaymentIntentPolicyReading => ({
      kind: "policy",
      policy,
    });

    it.each<{
      reading: PaymentIntentPolicyReading;
      paymentFee: PaymentFeeState;
      expected: ReturnType<typeof decideUpdatePolicy>;
    }>([
      { reading: POLICY("paypal-only"), paymentFee: ABSENT, expected: { outcome: "refused", code: "PAYMENT_FEE_REQUIRED" } },
      { reading: POLICY("paypal-only"), paymentFee: VALID, expected: { outcome: "update" } },
      { reading: POLICY("paypal-only"), paymentFee: INVALID, expected: { outcome: "refused", code: "PAYMENT_FEE_STALE" } },
      { reading: POLICY("no-paypal"), paymentFee: ABSENT, expected: { outcome: "update" } },
      { reading: POLICY("no-paypal"), paymentFee: VALID, expected: { outcome: "refused", code: "PAYMENT_FEE_PRESENT" } },
      { reading: POLICY("no-paypal"), paymentFee: INVALID, expected: { outcome: "refused", code: "PAYMENT_FEE_PRESENT" } },
      { reading: { kind: "legacy" }, paymentFee: ABSENT, expected: { outcome: "refused", code: "PAYMENT_POLICY_REINIT" } },
      { reading: { kind: "legacy" }, paymentFee: VALID, expected: { outcome: "refused", code: "PAYMENT_POLICY_REINIT" } },
      { reading: { kind: "legacy" }, paymentFee: INVALID, expected: { outcome: "refused", code: "PAYMENT_POLICY_REINIT" } },
      {
        reading: { kind: "inconsistent", tagged: "no-paypal" },
        paymentFee: ABSENT,
        expected: { outcome: "refused", code: "PAYMENT_POLICY_REINIT" },
      },
    ])(
      "$reading.kind $reading.policy with fee $paymentFee.status -> $expected.outcome $expected.code",
      ({ reading, paymentFee, expected }) => {
        expect(decideUpdatePolicy({ paymentIntentPolicy: reading, paymentFee })).toStrictEqual(expected);
      },
    );
  });

  describe("reading the policy of a PaymentIntent (metadata AND live fields, §2d)", () => {
    it("reads paypal-only", () => {
      expect(readPaymentIntentPolicy(paypalOnly())).toStrictEqual({ kind: "policy", policy: "paypal-only" });
    });

    it("reads no-paypal", () => {
      expect(readPaymentIntentPolicy(noPaypal())).toStrictEqual({ kind: "policy", policy: "no-paypal" });
    });

    it("reads a PaymentIntent without the metadata as legacy", () => {
      expect(readPaymentIntentPolicy(legacy())).toStrictEqual({ kind: "legacy" });
      expect(readPaymentIntentPolicy({ ...legacy(), metadata: {} })).toStrictEqual({ kind: "legacy" });
    });

    it.each<{ case: string; pi: PolicyFields }>([
      { case: "paypal-only tag on a PaymentIntent that offers card too", pi: paypalOnly({ payment_method_types: ["paypal", "card"] }) },
      {
        case: "paypal-only tag on an automatic PaymentIntent",
        pi: paypalOnly({ automatic_payment_methods: { enabled: true, allow_redirects: "always" } }),
      },
      { case: "no-paypal tag without the exclusion", pi: noPaypal({ excluded_payment_method_types: null }) },
      {
        case: "no-paypal tag on a PaymentIntent that offers PayPal",
        pi: noPaypal({ payment_method_types: ["card", "paypal"] }),
      },
      { case: "an unknown tag", pi: noPaypal({ metadata: { [PAYMENT_POLICY_METADATA_KEY]: "anything" } }) },
    ])("reads $case as inconsistent", ({ pi }) => {
      expect(readPaymentIntentPolicy(pi).kind).toBe("inconsistent");
    });

    it("matches a PaymentIntent only against its own policy", () => {
      expect(paymentIntentHasPolicy(paypalOnly(), "paypal-only")).toBe(true);
      expect(paymentIntentHasPolicy(paypalOnly(), "no-paypal")).toBe(false);
      expect(paymentIntentHasPolicy(noPaypal(), "no-paypal")).toBe(true);
      expect(paymentIntentHasPolicy(noPaypal(), "paypal-only")).toBe(false);
      expect(paymentIntentHasPolicy(legacy(), "no-paypal")).toBe(false);
      expect(paymentIntentHasPolicy(legacy(), "paypal-only")).toBe(false);
      expect(paymentIntentHasPolicy(noPaypal({ excluded_payment_method_types: [] }), "no-paypal")).toBe(false);
    });

    it("uses the metadata key the storefront contract names", () => {
      expect(PAYMENT_POLICY_METADATA_KEY).toBe("saleor_payment_policy");
    });
  });
});
