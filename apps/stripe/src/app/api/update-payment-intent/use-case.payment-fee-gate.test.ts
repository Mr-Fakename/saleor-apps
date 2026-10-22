import { APL } from "@saleor/app-sdk/APL";
import { ok } from "neverthrow";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockedSaleorChannelId } from "@/__tests__/mocks/constants";
import { mockAuthData } from "@/__tests__/mocks/mock-auth-data";
import { mockedStripePaymentIntentsApi } from "@/__tests__/mocks/mocked-stripe-payment-intents-api";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { PaymentFeeGateConfig } from "@/modules/payment-fee-gate/payment-fee-gate-config";
import {
  CheckoutPaymentStateTransaction,
  CheckoutPaymentStateWithLines,
  ICheckoutPaymentStateFetcher,
} from "@/modules/saleor/checkout-payment-state-fetcher";
import { IStripePaymentIntentsApiFactory } from "@/modules/stripe/types";

import {
  UpdatePaymentIntentAmountUseCase,
  UpdatePaymentIntentErrors,
  UpdatePaymentIntentRequest,
} from "./use-case";

/*
 * PayPal-fee hard gate on /api/update-payment-intent (A3c §2c): the policy is read from the
 * PaymentIntent (metadata and live fields), the fee state fresh from Saleor. A refusal is a 409
 * with a `code` and never writes to Stripe.
 */

const CHECKOUT_ID = "Q2hlY2tvdXQ6MQ==";
const TRANSACTION_ID = "VHJhbnNhY3Rpb25JdGVtOjE=";
const PAYMENT_INTENT_ID = "pi_3GateTest";
const FEE_VARIANT_ID = "UHJvZHVjdFZhcmlhbnQ6NDQ5";

const GATE: PaymentFeeGateConfig = {
  method: "paypal",
  ratePercent: 1.5,
  variantId: FEE_VARIANT_ID,
  metadataKey: "payment_fee_type",
};

const eur = (amount: number) => ({ amount, currency: "EUR" });

const transaction = (
  overrides: Partial<CheckoutPaymentStateTransaction> = {},
): CheckoutPaymentStateTransaction => ({
  id: TRANSACTION_ID,
  pspReference: PAYMENT_INTENT_ID,
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

const productLine = {
  id: "Q2hlY2tvdXRMaW5lOjE=",
  quantity: 1,
  variant: { id: "UHJvZHVjdFZhcmlhbnQ6MTI=" },
  metadata: [],
  totalPrice: { gross: eur(210) },
};

const feeLine = (amount: number) => ({
  id: "Q2hlY2tvdXRMaW5lOjI=",
  quantity: 1,
  variant: { id: FEE_VARIANT_ID },
  metadata: [{ key: "payment_fee_type", value: "paypal_1.5_percent" }],
  totalPrice: { gross: eur(amount) },
});

type FeeCase = "ABSENT" | "VALID" | "INVALID";

/** Base 210.00; a valid 1.5 % fee is 3.15, a stale one 3.00. */
const checkoutWithFee = (fee: FeeCase): CheckoutPaymentStateWithLines => ({
  id: CHECKOUT_ID,
  channel: { id: mockedSaleorChannelId },
  totalPrice: { gross: eur({ ABSENT: 210, VALID: 213.15, INVALID: 213 }[fee]) },
  transactions: [transaction()],
  lines: {
    ABSENT: [productLine],
    VALID: [productLine, feeLine(3.15)],
    INVALID: [productLine, feeLine(3)],
  }[fee],
});

const POLICY_FIELDS = {
  "paypal-only": {
    metadata: { saleor_payment_policy: "paypal-only" },
    payment_method_types: ["paypal"],
    excluded_payment_method_types: null,
    automatic_payment_methods: null,
  },
  "no-paypal": {
    metadata: { saleor_payment_policy: "no-paypal" },
    payment_method_types: ["card", "klarna"],
    excluded_payment_method_types: ["paypal"],
    automatic_payment_methods: { enabled: true, allow_redirects: "always" },
  },
  legacy: {
    metadata: {},
    payment_method_types: ["card", "paypal", "klarna"],
    excluded_payment_method_types: null,
    automatic_payment_methods: { enabled: true, allow_redirects: "always" },
  },
  // Tagged no-PayPal but the live object offers PayPal: never trusted.
  inconsistent: {
    metadata: { saleor_payment_policy: "no-paypal" },
    payment_method_types: ["card", "paypal"],
    excluded_payment_method_types: null,
    automatic_payment_methods: { enabled: true, allow_redirects: "always" },
  },
} as const;

type PolicyCase = keyof typeof POLICY_FIELDS;

const paymentIntent = (policy: PolicyCase, overrides: Partial<Stripe.PaymentIntent> = {}) => {
  const fields = POLICY_FIELDS[policy];

  return {
    id: PAYMENT_INTENT_ID,
    object: "payment_intent",
    amount: 200_00,
    currency: "eur",
    status: "requires_payment_method",
    client_secret: `${PAYMENT_INTENT_ID}_secret_test`,
    payment_method_types: [...fields.payment_method_types],
    excluded_payment_method_types: fields.excluded_payment_method_types
      ? [...fields.excluded_payment_method_types]
      : null,
    automatic_payment_methods: fields.automatic_payment_methods
      ? { ...fields.automatic_payment_methods }
      : null,
    ...overrides,
    metadata: {
      saleor_source_id: CHECKOUT_ID,
      saleor_source_type: "Checkout",
      saleor_transaction_id: TRANSACTION_ID,
      ...fields.metadata,
      ...overrides.metadata,
    },
  } as Stripe.PaymentIntent;
};

const request = (overrides: Partial<UpdatePaymentIntentRequest> = {}): UpdatePaymentIntentRequest => ({
  paymentIntentId: PAYMENT_INTENT_ID,
  amount: 213.15,
  currency: "EUR",
  channelId: mockedSaleorChannelId,
  saleorApiUrl: mockedSaleorApiUrl,
  ...overrides,
});

const mockApl = { get: vi.fn() } satisfies Pick<APL, "get">;
const mockCheckoutFetcher = {
  fetchCheckoutPaymentState: vi.fn(),
} satisfies ICheckoutPaymentStateFetcher;

const stripePaymentIntentsApiFactory = {
  create: () => mockedStripePaymentIntentsApi,
} satisfies IStripePaymentIntentsApiFactory;

const createUseCase = (paymentFeeGate?: PaymentFeeGateConfig | null) =>
  new UpdatePaymentIntentAmountUseCase({
    apl: mockApl,
    appConfigRepo: mockedAppConfigRepo,
    stripePaymentIntentsApiFactory,
    checkoutPaymentStateFetcherFactory: () => mockCheckoutFetcher,
    ...(paymentFeeGate === undefined ? {} : { paymentFeeGate }),
  });

const getMock = () => vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent);
const updateMock = () => vi.mocked(mockedStripePaymentIntentsApi.updatePaymentIntent);

const given = (args: { policy: PolicyCase; fee: FeeCase }) => {
  getMock().mockResolvedValue(ok(paymentIntent(args.policy)));
  mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(ok(checkoutWithFee(args.fee)));
};

describe("UpdatePaymentIntentAmountUseCase: PayPal-fee gate (A3c §2c)", () => {
  beforeEach(() => {
    mockApl.get.mockResolvedValue(mockAuthData);
    updateMock().mockImplementation(async (args) =>
      ok(paymentIntent("legacy", { amount: args.stripeMoney.amount, currency: args.stripeMoney.currency })),
    );
  });

  describe("gate on: decision table", () => {
    it.each<{ policy: PolicyCase; fee: FeeCase; amount: number }>([
      { policy: "paypal-only", fee: "VALID", amount: 213_15 },
      { policy: "no-paypal", fee: "ABSENT", amount: 210_00 },
    ])("$policy with fee $fee: updates the amount (today's path)", async ({ policy, fee, amount }) => {
      given({ policy, fee });

      const result = await createUseCase(GATE).execute(request());

      expect(result._unsafeUnwrap()).toStrictEqual({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount,
        currency: "eur",
        updated: true,
      });
      expect(updateMock()).toHaveBeenCalledOnce();
      expect(updateMock().mock.calls[0][0].stripeMoney.amount).toBe(amount);
    });

    it.each<{ policy: PolicyCase; fee: FeeCase; code: string }>([
      { policy: "paypal-only", fee: "ABSENT", code: "PAYMENT_FEE_REQUIRED" },
      { policy: "paypal-only", fee: "INVALID", code: "PAYMENT_FEE_STALE" },
      { policy: "no-paypal", fee: "VALID", code: "PAYMENT_FEE_PRESENT" },
      { policy: "no-paypal", fee: "INVALID", code: "PAYMENT_FEE_PRESENT" },
      { policy: "legacy", fee: "ABSENT", code: "PAYMENT_POLICY_REINIT" },
      { policy: "legacy", fee: "VALID", code: "PAYMENT_POLICY_REINIT" },
      { policy: "legacy", fee: "INVALID", code: "PAYMENT_POLICY_REINIT" },
      { policy: "inconsistent", fee: "ABSENT", code: "PAYMENT_POLICY_REINIT" },
    ])(
      "$policy with fee $fee: 409 $code, amount unchanged",
      async ({ policy, fee, code }) => {
        given({ policy, fee });

        const error = (await createUseCase(GATE).execute(request()))._unsafeUnwrapErr();

        expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.ConflictError);
        expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.PaymentPolicyConflictError);
        expect(error.httpStatus).toBe(409);
        expect(
          error instanceof UpdatePaymentIntentErrors.PaymentPolicyConflictError && error.code,
        ).toBe(code);
        expect(updateMock()).not.toHaveBeenCalled();
      },
    );

    it("does not write when the paypal-only PaymentIntent already holds base + fee", async () => {
      getMock().mockResolvedValue(ok(paymentIntent("paypal-only", { amount: 213_15 })));
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(ok(checkoutWithFee("VALID")));

      const result = await createUseCase(GATE).execute(request());

      expect(result._unsafeUnwrap().updated).toBe(false);
      expect(updateMock()).not.toHaveBeenCalled();
    });

    it("reads the checkout with its lines", async () => {
      given({ policy: "no-paypal", fee: "ABSENT" });

      await createUseCase(GATE).execute(request());

      expect(mockCheckoutFetcher.fetchCheckoutPaymentState.mock.calls).toStrictEqual([
        [{ checkoutId: CHECKOUT_ID, includeLines: true }],
      ]);
    });

    it("keeps the ownership checks first: a PaymentIntent of another channel's checkout is 403, not 409", async () => {
      given({ policy: "legacy", fee: "VALID" });
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(
        ok({ ...checkoutWithFee("VALID"), channel: { id: "Q2hhbm5lbDoy" } }),
      );

      const error = (await createUseCase(GATE).execute(request()))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.ForbiddenError);
      expect(updateMock()).not.toHaveBeenCalled();
    });

    it("keeps the status check first: a processing PaymentIntent is a plain 409 without a code", async () => {
      getMock().mockResolvedValue(ok(paymentIntent("paypal-only", { status: "processing" })));

      const error = (await createUseCase(GATE).execute(request()))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.ConflictError);
      expect(error).not.toBeInstanceOf(UpdatePaymentIntentErrors.PaymentPolicyConflictError);
      expect(mockCheckoutFetcher.fetchCheckoutPaymentState).not.toHaveBeenCalled();
    });
  });

  describe("gate off: today's use case", () => {
    it.each([undefined, null])(
      "updates a legacy PaymentIntent with a fee line present, reading the checkout with today's query (gate %s)",
      async (gate) => {
        given({ policy: "legacy", fee: "VALID" });

        const result = await createUseCase(gate).execute(request());

        expect(result._unsafeUnwrap()).toStrictEqual({
          paymentIntentId: PAYMENT_INTENT_ID,
          amount: 213_15,
          currency: "eur",
          updated: true,
        });
        expect(mockCheckoutFetcher.fetchCheckoutPaymentState.mock.calls).toStrictEqual([
          [{ checkoutId: CHECKOUT_ID }],
        ]);
        expect(updateMock().mock.calls).toStrictEqual([
          [{ id: PAYMENT_INTENT_ID, stripeMoney: expect.objectContaining({ amount: 213_15, currency: "eur" }) }],
        ]);
      },
    );

    it("never answers with a policy code", async () => {
      given({ policy: "paypal-only", fee: "ABSENT" });

      const result = await createUseCase().execute(request());

      expect(result.isOk()).toBe(true);
      expect(updateMock().mock.calls[0][0].stripeMoney.amount).toBe(210_00);
    });
  });
});
