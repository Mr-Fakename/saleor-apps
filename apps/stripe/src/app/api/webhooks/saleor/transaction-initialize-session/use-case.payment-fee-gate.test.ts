import { APL } from "@saleor/app-sdk/APL";
import { err, ok } from "neverthrow";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockedSaleorAppId, mockedSaleorChannelId, mockedSaleorTransactionId } from "@/__tests__/mocks/constants";
import { mockAuthData } from "@/__tests__/mocks/mock-auth-data";
import { mockedStripePaymentIntentsApi } from "@/__tests__/mocks/mocked-stripe-payment-intents-api";
import { MockedTransactionRecorder } from "@/__tests__/mocks/mocked-transaction-recorder";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { getMockedTransactionInitializeSessionEvent } from "@/__tests__/mocks/saleor-events/transaction-initialize-session-event";
import {
  TransactionInitializeSessionEventFragment,
  TransactionUpdateDocument,
  TransactionUpdateWithPolicyDocument,
} from "@/generated/graphql";
import { PaymentFeeGateConfig } from "@/modules/payment-fee-gate/payment-fee-gate-config";
import {
  CheckoutPaymentStateTransaction,
  CheckoutPaymentStateWithLines,
  ICheckoutPaymentStateFetcher,
} from "@/modules/saleor/checkout-payment-state-fetcher";
import { StripeAPIError } from "@/modules/stripe/stripe-api-error";
import { StripeMoney } from "@/modules/stripe/stripe-money";
import { CreatePaymentIntentArgs, IStripePaymentIntentsApiFactory } from "@/modules/stripe/types";
import { ChargeFailureResult } from "@/modules/transaction-result/failure-result";

import { parseTransactionInitializeSessionEventData } from "./event-data-parser";
import {
  PaymentFeePresentError,
  PaymentFeeRequiredError,
  PaymentFeeStaleError,
  PaymentMethodNotAllowedError,
} from "./payment-method-errors";
import { TransactionInitializeSessionUseCase } from "./use-case";
import { TransactionInitializeSessionUseCaseResponses } from "./use-case-response";

/*
 * PayPal-fee hard gate, server half (A3c, docs/plans/2026-10-22-paypal-fee-gate-design.md).
 * Gate on: the shopper's choice (data.paymentIntent.paymentMethod) and the checkout's fee line
 * decide which payment methods the PaymentIntent offers (§2b, §2d). Gate off: every path is
 * today's (§4 off-path proofs).
 */

const { saleorMutation } = vi.hoisted(() => ({ saleorMutation: vi.fn() }));

vi.mock("@/lib/saleor-app", () => ({
  saleorApp: {
    apl: {
      get: vi.fn(async () => ({
        token: "<app-token>",
        saleorApiUrl: "https://foo.bar.saleor.cloud/graphql/",
        appId: "mocked-saleor-app-id",
      })),
    },
  },
}));

vi.mock("@/lib/graphql-client", () => ({
  createInstrumentedGraphqlClient: vi.fn(() => ({ mutation: saleorMutation })),
}));

const CHECKOUT_ID = "mock-channel-1"; // sourceObject.id of the mocked event
const FEE_VARIANT_ID = "UHJvZHVjdFZhcmlhbnQ6NDQ5";
const TX_1 = "VHJhbnNhY3Rpb25JdGVtOjEx";
const TX_2 = "VHJhbnNhY3Rpb25JdGVtOjEy";

const GATE: PaymentFeeGateConfig = {
  method: "paypal",
  ratePercent: 1.5,
  variantId: FEE_VARIANT_ID,
  metadataKey: "payment_fee_type",
};

const mockApl = { get: vi.fn() } satisfies Pick<APL, "get">;
const mockCheckoutFetcher = {
  fetchCheckoutPaymentState: vi.fn(),
} satisfies ICheckoutPaymentStateFetcher;

const stripePaymentIntentsApiFactory = {
  create: () => mockedStripePaymentIntentsApi,
} satisfies IStripePaymentIntentsApiFactory;

const createUseCase = (paymentFeeGate?: PaymentFeeGateConfig | null) =>
  new TransactionInitializeSessionUseCase({
    appConfigRepo: mockedAppConfigRepo,
    stripePaymentIntentsApiFactory,
    transactionRecorder: new MockedTransactionRecorder(),
    apl: mockApl,
    checkoutPaymentStateFetcherFactory: () => mockCheckoutFetcher,
    ...(paymentFeeGate === undefined ? {} : { paymentFeeGate }),
  });

const usd = (amount: number) => ({ amount, currency: "USD" });

const transaction = (
  overrides: Partial<CheckoutPaymentStateTransaction> = {},
): CheckoutPaymentStateTransaction => ({
  id: mockedSaleorTransactionId,
  pspReference: "",
  chargedAmount: usd(0),
  authorizedAmount: usd(0),
  chargePendingAmount: usd(0),
  authorizePendingAmount: usd(0),
  refundedAmount: usd(0),
  refundPendingAmount: usd(0),
  canceledAmount: usd(0),
  cancelPendingAmount: usd(0),
  events: [],
  ...overrides,
});

const productLine = {
  id: "Q2hlY2tvdXRMaW5lOjE=",
  quantity: 1,
  variant: { id: "UHJvZHVjdFZhcmlhbnQ6MTI=" },
  metadata: [],
  totalPrice: { gross: usd(100) },
};

const feeLine = (amount: number) => ({
  id: "Q2hlY2tvdXRMaW5lOjI=",
  quantity: 1,
  variant: { id: FEE_VARIANT_ID },
  metadata: [{ key: "payment_fee_type", value: "paypal_1.5_percent" }],
  totalPrice: { gross: usd(amount) },
});

type FeeCase = "ABSENT" | "VALID" | "INVALID";

/** Base 100.00; a valid 1.5 % fee is 1.50, a stale one 1.40. */
const checkoutWithFee = (
  fee: FeeCase,
  transactions: CheckoutPaymentStateTransaction[] = [transaction()],
): CheckoutPaymentStateWithLines => {
  const lines = {
    ABSENT: [productLine],
    VALID: [productLine, feeLine(1.5)],
    INVALID: [productLine, feeLine(1.4)],
  }[fee];
  const total = { ABSENT: 100, VALID: 101.5, INVALID: 101.4 }[fee];

  return {
    id: CHECKOUT_ID,
    channel: { id: mockedSaleorChannelId },
    totalPrice: { gross: usd(total) },
    transactions,
    lines,
  };
};

const givenCheckout = (checkout: CheckoutPaymentStateWithLines) =>
  mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(ok(checkout));

const event = (args: {
  paymentMethod: "card" | "paypal" | "klarna";
  existingPaymentIntentId?: string;
  sourceType?: "Checkout" | "Order";
  actionType?: "CHARGE" | "AUTHORIZATION";
  amount?: number;
}): TransactionInitializeSessionEventFragment => {
  const base = getMockedTransactionInitializeSessionEvent();

  return {
    ...base,
    action: { amount: args.amount ?? 100, currency: "USD", actionType: args.actionType ?? "CHARGE" },
    data: parseTransactionInitializeSessionEventData({
      paymentIntent: { paymentMethod: args.paymentMethod },
      ...(args.existingPaymentIntentId
        ? { existingPaymentIntentId: args.existingPaymentIntentId }
        : {}),
    })._unsafeUnwrap(),
    sourceObject: { ...base.sourceObject, __typename: args.sourceType ?? "Checkout" },
  };
};

const execute = (
  saleorEvent: TransactionInitializeSessionEventFragment,
  paymentFeeGate?: PaymentFeeGateConfig | null,
) =>
  createUseCase(paymentFeeGate).execute({
    saleorApiUrl: mockedSaleorApiUrl,
    appId: mockedSaleorAppId,
    event: saleorEvent,
  });

type ExecuteResult = Awaited<ReturnType<typeof execute>>;

const createMock = () => vi.mocked(mockedStripePaymentIntentsApi.createPaymentIntent);
const updateMock = () => vi.mocked(mockedStripePaymentIntentsApi.updatePaymentIntent);
const getMock = () => vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent);
const searchMock = () => vi.mocked(mockedStripePaymentIntentsApi.searchPaymentIntentsByCheckout);
const cancelMock = () => vi.mocked(mockedStripePaymentIntentsApi.cancelPaymentIntent);

const cancelledIds = () => cancelMock().mock.calls.map(([args]) => args.id);

/** Payment-method fields as Stripe returns them for each policy (S0, sandbox dess-e2e). */
const POLICY_FIELDS = {
  "paypal-only": {
    metadata: { saleor_payment_policy: "paypal-only" },
    payment_method_types: ["paypal"],
    excluded_payment_method_types: null,
    automatic_payment_methods: null,
  },
  "no-paypal": {
    metadata: { saleor_payment_policy: "no-paypal" },
    payment_method_types: ["card", "klarna", "link"],
    excluded_payment_method_types: ["paypal"],
    automatic_payment_methods: { enabled: true, allow_redirects: "always" },
  },
  legacy: {
    metadata: {},
    payment_method_types: ["card", "paypal", "klarna", "link"],
    excluded_payment_method_types: null,
    automatic_payment_methods: { enabled: true, allow_redirects: "always" },
  },
} as const;

type PolicyCase = keyof typeof POLICY_FIELDS;

const ownIntent = (
  id: string,
  policy: PolicyCase,
  overrides: Partial<Stripe.PaymentIntent> = {},
): Stripe.PaymentIntent => {
  const fields = POLICY_FIELDS[policy];

  return {
    id,
    object: "payment_intent",
    amount: 101_50,
    amount_received: 0,
    amount_capturable: 0,
    currency: "usd",
    status: "requires_payment_method",
    client_secret: `${id}_secret_test`,
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
      saleor_transaction_id: TX_1,
      ...fields.metadata,
      ...overrides.metadata,
    },
  } as Stripe.PaymentIntent;
};

const CANCELLABLE = new Set<Stripe.PaymentIntent.Status>([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "requires_capture",
]);
const UPDATABLE = new Set<Stripe.PaymentIntent.Status>([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

/**
 * In-memory Stripe: get, cancel and update follow Stripe's status rules; create builds the
 * PaymentIntent from the params, as Stripe does (allow-list, or automatic minus the exclusion).
 */
const givenStripe = (...intents: Stripe.PaymentIntent[]) => {
  const byId = new Map(intents.map((pi) => [pi.id, pi]));

  getMock().mockImplementation(async ({ id }) => {
    const pi = byId.get(id);

    return pi
      ? ok(pi)
      : err(
          new Stripe.errors.StripeInvalidRequestError({
            type: "invalid_request_error",
            code: "resource_missing",
            message: `No such payment_intent: '${id}'`,
          }),
        );
  });
  cancelMock().mockImplementation(async ({ id }) => {
    const pi = byId.get(id);

    if (!pi || !CANCELLABLE.has(pi.status)) {
      return err(new StripeAPIError("This PaymentIntent cannot be canceled"));
    }

    const canceled = { ...pi, status: "canceled" as const };

    byId.set(id, canceled);

    return ok(canceled);
  });
  updateMock().mockImplementation(async (args) => {
    const pi = byId.get(args.id);

    if (!pi || !UPDATABLE.has(pi.status)) {
      return err(new StripeAPIError("This PaymentIntent's amount cannot be updated"));
    }

    const updated = {
      ...pi,
      amount: args.stripeMoney.amount,
      currency: args.stripeMoney.currency,
      metadata: { ...pi.metadata, ...args.metadata },
    };

    byId.set(args.id, updated);

    return ok(updated);
  });
  createMock().mockImplementation(async (args: CreatePaymentIntentArgs) => {
    const params = args.intentParams;
    const excluded = params.excluded_payment_method_types ?? null;
    const created = {
      id: "pi_created",
      object: "payment_intent",
      amount: args.stripeMoney.amount,
      amount_received: 0,
      amount_capturable: 0,
      currency: args.stripeMoney.currency,
      status: "requires_payment_method",
      client_secret: "pi_created_secret_test",
      metadata: { ...args.metadata },
      payment_method_types:
        params.payment_method_types ??
        ["card", "paypal", "klarna", "link"].filter(
          (type) => !(excluded as string[] | null)?.includes(type),
        ),
      excluded_payment_method_types: excluded,
      automatic_payment_methods: params.automatic_payment_methods
        ? { enabled: true, allow_redirects: "always" }
        : null,
    } as Stripe.PaymentIntent;

    byId.set(created.id, created);

    return ok(created);
  });

  return byId;
};

const expectNoStripeCall = () => {
  expect(createMock()).not.toHaveBeenCalled();
  expect(updateMock()).not.toHaveBeenCalled();
  expect(getMock()).not.toHaveBeenCalled();
  expect(searchMock()).not.toHaveBeenCalled();
  expect(cancelMock()).not.toHaveBeenCalled();
};

const failureOf = (result: ExecuteResult) => {
  const response = result._unsafeUnwrap();

  expect(response).toBeInstanceOf(TransactionInitializeSessionUseCaseResponses.Failure);
  expect(response.transactionResult).toBeInstanceOf(ChargeFailureResult);

  return response as InstanceType<typeof TransactionInitializeSessionUseCaseResponses.Failure>;
};

const handedOut = (result: ExecuteResult) => {
  const response = result._unsafeUnwrap();

  expect(response).toBeInstanceOf(TransactionInitializeSessionUseCaseResponses.Success);

  return response instanceof TransactionInitializeSessionUseCaseResponses.Success
    ? response.stripePaymentIntentId
    : undefined;
};

const createdParams = () => {
  expect(createMock()).toHaveBeenCalledOnce();

  return createMock().mock.calls[0][0];
};

const mutationDocuments = () => saleorMutation.mock.calls.map(([document]) => document);

describe("TransactionInitializeSessionUseCase: PayPal-fee gate (A3c)", () => {
  beforeEach(() => {
    mockApl.get.mockResolvedValue(mockAuthData);
    searchMock().mockResolvedValue(ok([]));
    givenCheckout(checkoutWithFee("ABSENT"));
    givenStripe();
    saleorMutation.mockResolvedValue({
      data: { transactionUpdate: { transaction: { id: "mocked-transaction-id" }, errors: [] } },
    });
  });

  /*
   * §4 off-path proofs. These expectations were written from today's code (HEAD db99d178) and
   * pass on it unchanged.
   */
  describe("gate off: today's paths", () => {
    const todaysMetadata = {
      saleor_source_id: CHECKOUT_ID,
      saleor_source_type: "Checkout",
      saleor_transaction_id: mockedSaleorTransactionId,
    };

    it.each([
      {
        paymentMethod: "card" as const,
        actionType: "CHARGE" as const,
        options: { card: { capture_method: undefined } },
      },
      {
        paymentMethod: "card" as const,
        actionType: "AUTHORIZATION" as const,
        options: { card: { capture_method: "manual" } },
      },
      {
        paymentMethod: "paypal" as const,
        actionType: "CHARGE" as const,
        options: { paypal: { capture_method: undefined } },
      },
      {
        paymentMethod: "paypal" as const,
        actionType: "AUTHORIZATION" as const,
        options: { paypal: { capture_method: "manual" } },
      },
      {
        paymentMethod: "klarna" as const,
        actionType: "CHARGE" as const,
        options: { klarna: { capture_method: undefined } },
      },
      {
        paymentMethod: "klarna" as const,
        actionType: "AUTHORIZATION" as const,
        options: { klarna: { capture_method: "manual" } },
      },
    ])(
      "creates $paymentMethod ($actionType) PaymentIntents with today's exact params",
      async ({ paymentMethod, actionType, options }) => {
        for (const gate of [undefined, null]) {
          createMock().mockClear();

          const saleorEvent = event({ paymentMethod, actionType });

          await execute(saleorEvent, gate);

          expect(createMock().mock.calls).toStrictEqual([
            [
              {
                metadata: todaysMetadata,
                stripeMoney: StripeMoney.createFromSaleorAmount({
                  amount: 100,
                  currency: "USD",
                })._unsafeUnwrap(),
                idempotencyKey: saleorEvent.idempotencyKey,
                intentParams: {
                  automatic_payment_methods: { enabled: true },
                  payment_method_options: options,
                },
              },
            ],
          ]);
        }
      },
    );

    it("reads the checkout with today's query (no lines)", async () => {
      await execute(event({ paymentMethod: "card" }));

      expect(mockCheckoutFetcher.fetchCheckoutPaymentState.mock.calls).toStrictEqual([
        [{ checkoutId: CHECKOUT_ID }],
      ]);
    });

    it("sends only today's pspReference mutation to Saleor", async () => {
      await execute(event({ paymentMethod: "card" }));

      expect(saleorMutation.mock.calls).toStrictEqual([
        [
          TransactionUpdateDocument,
          { transactionId: mockedSaleorTransactionId, pspReference: "pi_created" },
        ],
      ]);
    });

    it("starts PayPal without a fee line, as today", async () => {
      const result = await execute(event({ paymentMethod: "paypal" }));

      expect(handedOut(result)).toBe("pi_created");
    });

    it("updates the storefront's PaymentIntent whatever its payment methods, as today", async () => {
      givenCheckout(checkoutWithFee("ABSENT", [transaction(), transaction({ id: TX_1, pspReference: "pi_legacy" })]));
      givenStripe(ownIntent("pi_legacy", "legacy", { amount: 50_00 }));

      const result = await execute(event({ paymentMethod: "card", existingPaymentIntentId: "pi_legacy" }));

      expect(handedOut(result)).toBe("pi_legacy");
      expect(createMock()).not.toHaveBeenCalled();
      expect(updateMock().mock.calls[0][0].stripeMoney.amount).toBe(100_00);
    });
  });

  describe("gate on: §2b decision table (checkout)", () => {
    it.each<{ paymentMethod: "paypal" | "card" | "klarna"; fee: FeeCase; error: unknown }>([
      { paymentMethod: "paypal", fee: "ABSENT", error: PaymentFeeRequiredError },
      { paymentMethod: "paypal", fee: "INVALID", error: PaymentFeeStaleError },
      { paymentMethod: "card", fee: "VALID", error: PaymentFeePresentError },
      { paymentMethod: "card", fee: "INVALID", error: PaymentFeePresentError },
      { paymentMethod: "klarna", fee: "VALID", error: PaymentFeePresentError },
    ])(
      "refuses $paymentMethod with fee $fee before any Stripe call",
      async ({ paymentMethod, fee, error }) => {
        givenCheckout(checkoutWithFee(fee));

        const result = await execute(event({ paymentMethod }), GATE);
        const failure = failureOf(result);

        expect(failure.error).toBeInstanceOf(error);
        expect(failure.error).toBeInstanceOf(PaymentMethodNotAllowedError);
        expectNoStripeCall();
        expect(saleorMutation).not.toHaveBeenCalled();

        const json = (await failure.getResponse().json()) as {
          data: { paymentIntent: { errors: unknown } };
          result: string;
        };

        expect(json.data.paymentIntent.errors).toStrictEqual([
          { code: "PaymentMethodNotAllowedError", message: expect.any(String) },
        ]);
        expect(json.result).toBe("CHARGE_FAILURE");
      },
    );

    it("refuses before any Stripe call even when the storefront names a PaymentIntent", async () => {
      givenCheckout(checkoutWithFee("ABSENT"));

      const result = await execute(
        event({ paymentMethod: "paypal", existingPaymentIntentId: "pi_storefront" }),
        GATE,
      );

      expect(failureOf(result).error).toBeInstanceOf(PaymentFeeRequiredError);
      expectNoStripeCall();
    });

    it("creates a PayPal-only PaymentIntent for PayPal with a valid fee, charging base + fee", async () => {
      givenCheckout(checkoutWithFee("VALID"));

      const saleorEvent = event({ paymentMethod: "paypal" });
      const result = await execute(saleorEvent, GATE);

      expect(handedOut(result)).toBe("pi_created");
      expect(createdParams()).toStrictEqual({
        metadata: {
          saleor_source_id: CHECKOUT_ID,
          saleor_source_type: "Checkout",
          saleor_transaction_id: mockedSaleorTransactionId,
          saleor_payment_policy: "paypal-only",
        },
        stripeMoney: StripeMoney.createFromSaleorAmount({ amount: 101.5, currency: "USD" })._unsafeUnwrap(),
        idempotencyKey: saleorEvent.idempotencyKey,
        intentParams: {
          payment_method_types: ["paypal"],
          payment_method_options: { paypal: { capture_method: undefined } },
        },
      });
    });

    it("keeps PayPal's manual capture for an authorization", async () => {
      givenCheckout(checkoutWithFee("VALID"));

      await execute(event({ paymentMethod: "paypal", actionType: "AUTHORIZATION" }), GATE);

      expect(createdParams().intentParams).toStrictEqual({
        payment_method_types: ["paypal"],
        payment_method_options: { paypal: { capture_method: "manual" } },
      });
    });

    it("creates a no-PayPal PaymentIntent for card without a fee", async () => {
      const saleorEvent = event({ paymentMethod: "card" });
      const result = await execute(saleorEvent, GATE);

      expect(handedOut(result)).toBe("pi_created");
      expect(createdParams()).toStrictEqual({
        metadata: {
          saleor_source_id: CHECKOUT_ID,
          saleor_source_type: "Checkout",
          saleor_transaction_id: mockedSaleorTransactionId,
          saleor_payment_policy: "no-paypal",
        },
        stripeMoney: StripeMoney.createFromSaleorAmount({ amount: 100, currency: "USD" })._unsafeUnwrap(),
        idempotencyKey: saleorEvent.idempotencyKey,
        intentParams: {
          automatic_payment_methods: { enabled: true },
          excluded_payment_method_types: ["paypal"],
          payment_method_options: { card: { capture_method: undefined } },
        },
      });
    });

    it("creates a no-PayPal PaymentIntent with the chosen method's options for another method", async () => {
      await execute(event({ paymentMethod: "klarna", actionType: "AUTHORIZATION" }), GATE);

      expect(createdParams().intentParams).toStrictEqual({
        automatic_payment_methods: { enabled: true },
        excluded_payment_method_types: ["paypal"],
        payment_method_options: { klarna: { capture_method: "manual" } },
      });
      expect(createdParams().metadata?.saleor_payment_policy).toBe("no-paypal");
    });

    it("reads the checkout with its lines", async () => {
      await execute(event({ paymentMethod: "card" }), GATE);

      expect(mockCheckoutFetcher.fetchCheckoutPaymentState.mock.calls).toStrictEqual([
        [{ checkoutId: CHECKOUT_ID, includeLines: true }],
      ]);
    });
  });

  describe("gate on: Order source (no checkout fee to verify)", () => {
    it("creates a no-PayPal PaymentIntent for card without reading a checkout", async () => {
      const result = await execute(event({ paymentMethod: "card", sourceType: "Order", amount: 12.34 }), GATE);

      expect(handedOut(result)).toBe("pi_created");
      expect(mockCheckoutFetcher.fetchCheckoutPaymentState).not.toHaveBeenCalled();
      expect(createdParams().intentParams).toStrictEqual({
        automatic_payment_methods: { enabled: true },
        excluded_payment_method_types: ["paypal"],
        payment_method_options: { card: { capture_method: undefined } },
      });
      expect(createdParams().metadata).toStrictEqual({
        saleor_source_id: CHECKOUT_ID,
        saleor_source_type: "Order",
        saleor_transaction_id: mockedSaleorTransactionId,
        saleor_payment_policy: "no-paypal",
      });
    });

    it("refuses an explicit PayPal choice before any Stripe call", async () => {
      const result = await execute(event({ paymentMethod: "paypal", sourceType: "Order", amount: 12.34 }), GATE);

      expect(failureOf(result).error).toBeInstanceOf(PaymentFeeRequiredError);
      expect(mockCheckoutFetcher.fetchCheckoutPaymentState).not.toHaveBeenCalled();
      expectNoStripeCall();
    });
  });

  /*
   * §2d: a PaymentIntent is reused only when it already has the policy this request needs.
   * Switching choice cancels it and creates one (§3): in-place switching is impossible (S0).
   */
  describe("gate on: policy check on every reuse path", () => {
    describe("1. the storefront's PaymentIntent (existingPaymentIntentId)", () => {
      it("updates and hands it out when it has the required policy", async () => {
        givenCheckout(checkoutWithFee("VALID", [transaction(), transaction({ id: TX_1, pspReference: "pi_sf" })]));
        givenStripe(ownIntent("pi_sf", "paypal-only", { amount: 100_00 }));

        const result = await execute(
          event({ paymentMethod: "paypal", existingPaymentIntentId: "pi_sf" }),
          GATE,
        );

        expect(handedOut(result)).toBe("pi_sf");
        expect(updateMock().mock.calls[0][0].stripeMoney.amount).toBe(101_50);
        expect(createMock()).not.toHaveBeenCalled();
      });

      it.each<PolicyCase>(["no-paypal", "legacy"])(
        "replaces a %s PaymentIntent when the shopper chose PayPal: cancels it and creates a PayPal-only one",
        async (policy) => {
          givenCheckout(checkoutWithFee("VALID", [transaction(), transaction({ id: TX_1, pspReference: "pi_sf" })]));
          givenStripe(ownIntent("pi_sf", policy, { amount: 100_00 }));

          const result = await execute(
            event({ paymentMethod: "paypal", existingPaymentIntentId: "pi_sf" }),
            GATE,
          );

          expect(handedOut(result)).toBe("pi_created");
          expect(updateMock()).not.toHaveBeenCalled();
          expect(cancelledIds()).toStrictEqual(["pi_sf"]);
          expect(createdParams().intentParams.payment_method_types).toStrictEqual(["paypal"]);
        },
      );

      it.each<PolicyCase>(["paypal-only", "legacy"])(
        "replaces a %s PaymentIntent when the shopper chose card",
        async (policy) => {
          givenCheckout(checkoutWithFee("ABSENT", [transaction(), transaction({ id: TX_1, pspReference: "pi_sf" })]));
          givenStripe(ownIntent("pi_sf", policy, { amount: 101_50 }));

          const result = await execute(
            event({ paymentMethod: "card", existingPaymentIntentId: "pi_sf" }),
            GATE,
          );

          expect(handedOut(result)).toBe("pi_created");
          expect(updateMock()).not.toHaveBeenCalled();
          expect(cancelledIds()).toStrictEqual(["pi_sf"]);
          expect(createdParams().intentParams.excluded_payment_method_types).toStrictEqual(["paypal"]);
        },
      );

      it("still refuses while the storefront's PaymentIntent is being paid, whatever its policy", async () => {
        givenCheckout(checkoutWithFee("VALID", [transaction(), transaction({ id: TX_1, pspReference: "pi_sf" })]));
        givenStripe(ownIntent("pi_sf", "no-paypal", { status: "processing" }));

        const result = await execute(
          event({ paymentMethod: "paypal", existingPaymentIntentId: "pi_sf" }),
          GATE,
        );

        expect(failureOf(result).error?.name).toBe("PaymentInFlightError");
        expect(createMock()).not.toHaveBeenCalled();
      });
    });

    describe("2. the exact-amount PaymentIntent found by search", () => {
      it("reuses it when it has the required policy", async () => {
        const found = ownIntent("pi_found", "no-paypal", { amount: 100_00 });

        givenStripe(found);
        searchMock().mockResolvedValue(ok([found]));

        const result = await execute(event({ paymentMethod: "card" }), GATE);

        expect(handedOut(result)).toBe("pi_found");
        expect(createMock()).not.toHaveBeenCalled();
        expect(updateMock()).not.toHaveBeenCalled();
      });

      it.each<PolicyCase>(["paypal-only", "legacy"])(
        "does not reuse a %s one for card: cancels it and creates a no-PayPal one",
        async (policy) => {
          const found = ownIntent("pi_found", policy, { amount: 100_00 });

          givenStripe(found);
          searchMock().mockResolvedValue(ok([found]));

          const result = await execute(event({ paymentMethod: "card" }), GATE);

          expect(handedOut(result)).toBe("pi_created");
          expect(updateMock()).not.toHaveBeenCalled();
          expect(cancelledIds()).toStrictEqual(["pi_found"]);
          expect(createdParams().metadata?.saleor_payment_policy).toBe("no-paypal");
        },
      );
    });

    describe("3. the live re-read of the PaymentIntent found by search", () => {
      it("does not hand it out when its live payment methods contradict its policy tag", async () => {
        // The search result looks no-PayPal; the live object offers PayPal.
        const indexed = ownIntent("pi_found", "no-paypal", { amount: 100_00 });
        const live = { ...indexed, excluded_payment_method_types: null, payment_method_types: ["card", "paypal"] };

        givenStripe(live as Stripe.PaymentIntent);
        searchMock().mockResolvedValue(ok([indexed]));

        const result = await execute(event({ paymentMethod: "card" }), GATE);

        expect(handedOut(result)).toBe("pi_created");
        expect(updateMock()).not.toHaveBeenCalled();
        expect(cancelledIds()).toStrictEqual(["pi_found"]);
      });
    });

    describe("4. a found PaymentIntent with another amount (update in place)", () => {
      it("updates it when it has the required policy", async () => {
        const found = ownIntent("pi_found", "paypal-only", { amount: 90_00 });

        givenCheckout(checkoutWithFee("VALID"));
        givenStripe(found);
        searchMock().mockResolvedValue(ok([found]));

        const result = await execute(event({ paymentMethod: "paypal" }), GATE);

        expect(handedOut(result)).toBe("pi_found");
        expect(updateMock().mock.calls[0][0].stripeMoney.amount).toBe(101_50);
        expect(createMock()).not.toHaveBeenCalled();
      });

      it.each<PolicyCase>(["no-paypal", "legacy"])(
        "does not update a %s one for PayPal: cancels it and creates a PayPal-only one",
        async (policy) => {
          const found = ownIntent("pi_found", policy, { amount: 90_00 });

          givenCheckout(checkoutWithFee("VALID"));
          givenStripe(found);
          searchMock().mockResolvedValue(ok([found]));

          const result = await execute(event({ paymentMethod: "paypal" }), GATE);

          expect(handedOut(result)).toBe("pi_created");
          expect(updateMock()).not.toHaveBeenCalled();
          expect(cancelledIds()).toStrictEqual(["pi_found"]);
          expect(createdParams().intentParams.payment_method_types).toStrictEqual(["paypal"]);
        },
      );
    });

    it("cancels every other payable PaymentIntent of the checkout before handing out the new one", async () => {
      givenCheckout(
        checkoutWithFee("VALID", [
          transaction(),
          transaction({ id: TX_1, pspReference: "pi_card" }),
          transaction({ id: TX_2, pspReference: "pi_old" }),
        ]),
      );
      givenStripe(
        ownIntent("pi_card", "no-paypal", { amount: 100_00 }),
        ownIntent("pi_old", "legacy", { amount: 100_00, status: "requires_action" }),
      );

      const result = await execute(
        event({ paymentMethod: "paypal", existingPaymentIntentId: "pi_card" }),
        GATE,
      );

      expect(handedOut(result)).toBe("pi_created");
      expect([...cancelledIds()].sort()).toStrictEqual(["pi_card", "pi_old"]);
    });
  });

  describe("gate on: the Saleor transaction is tagged with the policy (§6.3)", () => {
    it("tags it after the pspReference update", async () => {
      givenCheckout(checkoutWithFee("VALID"));

      await execute(event({ paymentMethod: "paypal" }), GATE);

      expect(mutationDocuments()).toStrictEqual([
        TransactionUpdateDocument,
        TransactionUpdateWithPolicyDocument,
      ]);
      expect(saleorMutation.mock.calls[0][1]).toStrictEqual({
        transactionId: mockedSaleorTransactionId,
        pspReference: "pi_created",
      });
      expect(saleorMutation.mock.calls[1][1]).toStrictEqual({
        transactionId: mockedSaleorTransactionId,
        metadata: [{ key: "stripe_payment_policy", value: "paypal-only" }],
      });
    });

    it("tags a reused PaymentIntent's transaction too", async () => {
      const found = ownIntent("pi_found", "no-paypal", { amount: 100_00 });

      givenStripe(found);
      searchMock().mockResolvedValue(ok([found]));

      await execute(event({ paymentMethod: "card" }), GATE);

      expect(saleorMutation.mock.calls[1]).toStrictEqual([
        TransactionUpdateWithPolicyDocument,
        {
          transactionId: mockedSaleorTransactionId,
          metadata: [{ key: "stripe_payment_policy", value: "no-paypal" }],
        },
      ]);
    });

    it("still hands out the PaymentIntent when the tag cannot be written", async () => {
      saleorMutation.mockImplementation(async (document) =>
        document === TransactionUpdateWithPolicyDocument
          ? { error: new Error("Saleor unavailable") }
          : { data: { transactionUpdate: { transaction: { id: "mocked-transaction-id" }, errors: [] } } },
      );

      const result = await execute(event({ paymentMethod: "card" }), GATE);

      expect(handedOut(result)).toBe("pi_created");
    });
  });
});
