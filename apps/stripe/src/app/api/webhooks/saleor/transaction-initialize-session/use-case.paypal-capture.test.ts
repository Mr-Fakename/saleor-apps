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
import { TransactionInitializeSessionEventFragment } from "@/generated/graphql";
import { PaymentFeeGateConfig } from "@/modules/payment-fee-gate/payment-fee-gate-config";
import { PaypalCaptureMode } from "@/modules/payment-fee-gate/paypal-capture-config";
import {
  CheckoutPaymentStateTransaction,
  CheckoutPaymentStateWithLines,
  ICheckoutPaymentStateFetcher,
} from "@/modules/saleor/checkout-payment-state-fetcher";
import { StripeAPIError } from "@/modules/stripe/stripe-api-error";
import { StripeMoney } from "@/modules/stripe/stripe-money";
import { CreatePaymentIntentArgs, IStripePaymentIntentsApiFactory } from "@/modules/stripe/types";

import { parseTransactionInitializeSessionEventData } from "./event-data-parser";
import { TransactionInitializeSessionUseCase } from "./use-case";
import { TransactionInitializeSessionUseCaseResponses } from "./use-case-response";

/*
 * A3d (authorize, then capture), create params. With the PayPal-fee gate on and
 * PAYMENT_FEE_PAYPAL_CAPTURE=manual (the default), a paypal-only PaymentIntent is created with
 * payment_method_options.paypal.capture_method "manual": PayPal approval only authorizes it, and
 * the app captures after checking the order. Everything else is unchanged:
 * - no-paypal (card and the others): the same params as the gate before A3d;
 * - automatic (kill switch): the same params as the gate before A3d;
 * - gate off (SDS): today's params, whatever the capture mode passed.
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

const GATE: PaymentFeeGateConfig = {
  method: "paypal",
  ratePercent: 1.5,
  variantId: FEE_VARIANT_ID,
  metadataKey: "payment_fee_type",
};

const mockApl = { get: vi.fn() } satisfies Pick<APL, "get">;
const mockCheckoutFetcher = { fetchCheckoutPaymentState: vi.fn() } satisfies ICheckoutPaymentStateFetcher;
const stripePaymentIntentsApiFactory = {
  create: () => mockedStripePaymentIntentsApi,
} satisfies IStripePaymentIntentsApiFactory;

const usd = (amount: number) => ({ amount, currency: "USD" });

const transaction = (overrides: Partial<CheckoutPaymentStateTransaction> = {}): CheckoutPaymentStateTransaction => ({
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
  undiscountedTotalPrice: usd(100),
};

const feeLine = {
  id: "Q2hlY2tvdXRMaW5lOjI=",
  quantity: 1,
  variant: { id: FEE_VARIANT_ID },
  metadata: [{ key: "payment_fee_type", value: "paypal_1.5_percent" }],
  totalPrice: { gross: usd(1.5) },
  undiscountedTotalPrice: usd(1.5),
};

const checkout = (
  fee: "ABSENT" | "VALID",
  transactions: CheckoutPaymentStateTransaction[] = [transaction()],
): CheckoutPaymentStateWithLines => ({
  id: CHECKOUT_ID,
  channel: { id: mockedSaleorChannelId },
  totalPrice: { gross: usd(fee === "VALID" ? 101.5 : 100) },
  transactions,
  lines: fee === "VALID" ? [productLine, feeLine] : [productLine],
});

const event = (args: {
  paymentMethod: "card" | "paypal" | "klarna";
  actionType?: "CHARGE" | "AUTHORIZATION";
  existingPaymentIntentId?: string;
}): TransactionInitializeSessionEventFragment => {
  const base = getMockedTransactionInitializeSessionEvent();

  return {
    ...base,
    action: { amount: 100, currency: "USD", actionType: args.actionType ?? "CHARGE" },
    data: parseTransactionInitializeSessionEventData({
      paymentIntent: { paymentMethod: args.paymentMethod },
      ...(args.existingPaymentIntentId ? { existingPaymentIntentId: args.existingPaymentIntentId } : {}),
    })._unsafeUnwrap(),
    sourceObject: { ...base.sourceObject, __typename: "Checkout" },
  };
};

const createUseCase = (args: { gate?: PaymentFeeGateConfig | null; paypalCapture?: PaypalCaptureMode | null }) =>
  new TransactionInitializeSessionUseCase({
    appConfigRepo: mockedAppConfigRepo,
    stripePaymentIntentsApiFactory,
    transactionRecorder: new MockedTransactionRecorder(),
    apl: mockApl,
    checkoutPaymentStateFetcherFactory: () => mockCheckoutFetcher,
    ...(args.gate === undefined ? {} : { paymentFeeGate: args.gate }),
    ...(args.paypalCapture === undefined ? {} : { paypalCapture: args.paypalCapture }),
  });

const execute = (
  saleorEvent: TransactionInitializeSessionEventFragment,
  args: { gate?: PaymentFeeGateConfig | null; paypalCapture?: PaypalCaptureMode | null },
) =>
  createUseCase(args).execute({ saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId, event: saleorEvent });

const createMock = () => vi.mocked(mockedStripePaymentIntentsApi.createPaymentIntent);
const getMock = () => vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent);
const updateMock = () => vi.mocked(mockedStripePaymentIntentsApi.updatePaymentIntent);
const cancelMock = () => vi.mocked(mockedStripePaymentIntentsApi.cancelPaymentIntent);
const searchMock = () => vi.mocked(mockedStripePaymentIntentsApi.searchPaymentIntentsByCheckout);

const createdParams = (): CreatePaymentIntentArgs => {
  expect(createMock()).toHaveBeenCalledOnce();

  return createMock().mock.calls[0][0];
};

const createdIntent = (args: CreatePaymentIntentArgs): Stripe.PaymentIntent =>
  ({
    id: "pi_created",
    object: "payment_intent",
    amount: args.stripeMoney.amount,
    amount_received: 0,
    amount_capturable: 0,
    currency: args.stripeMoney.currency,
    status: "requires_payment_method",
    client_secret: "pi_created_secret_test",
    metadata: { ...args.metadata },
    payment_method_types: args.intentParams.payment_method_types ?? ["card", "klarna"],
    excluded_payment_method_types: args.intentParams.excluded_payment_method_types ?? null,
    automatic_payment_methods: args.intentParams.automatic_payment_methods ? { enabled: true } : null,
    capture_method: "automatic_async",
    payment_method_options: args.intentParams.payment_method_options ?? null,
  }) as Stripe.PaymentIntent;

/** A paypal-only PaymentIntent as Stripe returns it, created with or without manual capture. */
const paypalOnlyIntent = (id: string, capture: "manual" | "automatic"): Stripe.PaymentIntent =>
  ({
    id,
    object: "payment_intent",
    amount: 101_50,
    amount_received: 0,
    amount_capturable: 0,
    currency: "usd",
    status: "requires_payment_method",
    client_secret: `${id}_secret_test`,
    metadata: {
      saleor_source_id: CHECKOUT_ID,
      saleor_source_type: "Checkout",
      saleor_transaction_id: "VHJhbnNhY3Rpb25JdGVtOjEx",
      saleor_payment_policy: "paypal-only",
    },
    payment_method_types: ["paypal"],
    excluded_payment_method_types: null,
    automatic_payment_methods: null,
    capture_method: "automatic_async",
    payment_method_options: { paypal: capture === "manual" ? { capture_method: "manual" } : {} },
  }) as unknown as Stripe.PaymentIntent;

const givenStripe = (...intents: Stripe.PaymentIntent[]) => {
  const byId = new Map(intents.map((pi) => [pi.id, pi]));

  getMock().mockImplementation(async ({ id }) => {
    const pi = byId.get(id);

    return pi
      ? ok(pi)
      : err(new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "resource_missing", message: "missing" }));
  });
  cancelMock().mockImplementation(async ({ id }) => {
    const pi = byId.get(id);

    if (!pi) {
      return err(new StripeAPIError("missing"));
    }

    const canceled = { ...pi, status: "canceled" as const };

    byId.set(id, canceled);

    return ok(canceled);
  });
  updateMock().mockImplementation(async (args) => {
    const pi = byId.get(args.id);

    if (!pi) {
      return err(new StripeAPIError("missing"));
    }

    const updated = { ...pi, amount: args.stripeMoney.amount, metadata: { ...pi.metadata, ...args.metadata } };

    byId.set(args.id, updated);

    return ok(updated);
  });
  createMock().mockImplementation(async (args) => ok(createdIntent(args)));
};

const handedOut = (result: Awaited<ReturnType<typeof execute>>) => {
  const response = result._unsafeUnwrap();

  expect(response).toBeInstanceOf(TransactionInitializeSessionUseCaseResponses.Success);

  return response instanceof TransactionInitializeSessionUseCaseResponses.Success
    ? response.stripePaymentIntentId
    : undefined;
};

const todaysMetadata = {
  saleor_source_id: CHECKOUT_ID,
  saleor_source_type: "Checkout",
  saleor_transaction_id: mockedSaleorTransactionId,
};

describe("TransactionInitializeSessionUseCase: A3d PayPal manual capture", () => {
  beforeEach(() => {
    mockApl.get.mockResolvedValue(mockAuthData);
    searchMock().mockResolvedValue(ok([]));
    mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(ok(checkout("ABSENT")));
    givenStripe();
    saleorMutation.mockResolvedValue({
      data: { transactionUpdate: { transaction: { id: "mocked-transaction-id" }, errors: [] } },
    });
  });

  describe("gate on, manual (default)", () => {
    it("creates the paypal-only PaymentIntent with PayPal manual capture on a CHARGE channel", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(ok(checkout("VALID")));

      const saleorEvent = event({ paymentMethod: "paypal" });
      const result = await execute(saleorEvent, { gate: GATE, paypalCapture: "manual" });

      expect(handedOut(result)).toBe("pi_created");
      expect(createdParams()).toStrictEqual({
        metadata: { ...todaysMetadata, saleor_payment_policy: "paypal-only" },
        stripeMoney: StripeMoney.createFromSaleorAmount({ amount: 101.5, currency: "USD" })._unsafeUnwrap(),
        idempotencyKey: saleorEvent.idempotencyKey,
        intentParams: {
          payment_method_types: ["paypal"],
          payment_method_options: { paypal: { capture_method: "manual" } },
        },
      });
    });

    it("keeps manual capture on an AUTHORIZATION channel (unchanged)", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(ok(checkout("VALID")));

      await execute(event({ paymentMethod: "paypal", actionType: "AUTHORIZATION" }), { gate: GATE, paypalCapture: "manual" });

      expect(createdParams().intentParams).toStrictEqual({
        payment_method_types: ["paypal"],
        payment_method_options: { paypal: { capture_method: "manual" } },
      });
    });

    it.each([
      { paymentMethod: "card" as const, actionType: "CHARGE" as const },
      { paymentMethod: "card" as const, actionType: "AUTHORIZATION" as const },
      { paymentMethod: "klarna" as const, actionType: "CHARGE" as const },
    ])(
      "creates $paymentMethod ($actionType) no-paypal PaymentIntents with exactly the params of the gate before A3d",
      async ({ paymentMethod, actionType }) => {
        await execute(event({ paymentMethod, actionType }), { gate: GATE });

        const before = createdParams();

        createMock().mockClear();
        await execute(event({ paymentMethod, actionType }), { gate: GATE, paypalCapture: "manual" });

        expect(createdParams()).toStrictEqual(before);
      },
    );

    it("does not hand out a paypal-only PaymentIntent created without manual capture: it is replaced", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(
        ok(checkout("VALID", [transaction(), transaction({ id: "VHJhbnNhY3Rpb25JdGVtOjEx", pspReference: "pi_auto" })])),
      );
      givenStripe(paypalOnlyIntent("pi_auto", "automatic"));

      const result = await execute(event({ paymentMethod: "paypal", existingPaymentIntentId: "pi_auto" }), {
        gate: GATE,
        paypalCapture: "manual",
      });

      expect(handedOut(result)).toBe("pi_created");
      expect(updateMock()).not.toHaveBeenCalled();
      expect(cancelMock().mock.calls.map(([args]) => args.id)).toStrictEqual(["pi_auto"]);
      expect(createdParams().intentParams.payment_method_options).toStrictEqual({ paypal: { capture_method: "manual" } });
    });

    it("does not reuse an automatic paypal-only PaymentIntent found by search either", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(ok(checkout("VALID")));
      givenStripe(paypalOnlyIntent("pi_found_auto", "automatic"));
      searchMock().mockResolvedValue(ok([paypalOnlyIntent("pi_found_auto", "automatic")]));

      const result = await execute(event({ paymentMethod: "paypal" }), { gate: GATE, paypalCapture: "manual" });

      expect(handedOut(result)).toBe("pi_created");
      expect(updateMock()).not.toHaveBeenCalled();
    });

    it("reuses a manual paypal-only PaymentIntent (the storefront's own)", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(
        ok(checkout("VALID", [transaction(), transaction({ id: "VHJhbnNhY3Rpb25JdGVtOjEx", pspReference: "pi_manual" })])),
      );
      givenStripe(paypalOnlyIntent("pi_manual", "manual"));

      const result = await execute(event({ paymentMethod: "paypal", existingPaymentIntentId: "pi_manual" }), {
        gate: GATE,
        paypalCapture: "manual",
      });

      expect(handedOut(result)).toBe("pi_manual");
      expect(createMock()).not.toHaveBeenCalled();
    });
  });

  describe("gate on, automatic (kill switch)", () => {
    it.each([
      { paymentMethod: "paypal" as const, fee: "VALID" as const },
      { paymentMethod: "card" as const, fee: "ABSENT" as const },
    ])("creates $paymentMethod PaymentIntents with exactly the params of the gate before A3d", async ({ paymentMethod, fee }) => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(ok(checkout(fee)));

      await execute(event({ paymentMethod }), { gate: GATE });

      const before = createdParams();

      createMock().mockClear();
      await execute(event({ paymentMethod }), { gate: GATE, paypalCapture: "automatic" });

      expect(createdParams()).toStrictEqual(before);
    });

    it("leaves PayPal capture to Stripe", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(ok(checkout("VALID")));

      await execute(event({ paymentMethod: "paypal" }), { gate: GATE, paypalCapture: "automatic" });

      expect(createdParams().intentParams.payment_method_options).toStrictEqual({ paypal: { capture_method: undefined } });
    });

    it("may still hand out a manual paypal-only PaymentIntent created before the switch (the worker captures it)", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(
        ok(checkout("VALID", [transaction(), transaction({ id: "VHJhbnNhY3Rpb25JdGVtOjEx", pspReference: "pi_manual" })])),
      );
      givenStripe(paypalOnlyIntent("pi_manual", "manual"));

      const result = await execute(event({ paymentMethod: "paypal", existingPaymentIntentId: "pi_manual" }), {
        gate: GATE,
        paypalCapture: "automatic",
      });

      expect(handedOut(result)).toBe("pi_manual");
    });
  });

  describe("gate off: today's params whatever the capture mode", () => {
    it.each([
      { paymentMethod: "card" as const, actionType: "CHARGE" as const, options: { card: { capture_method: undefined } } },
      { paymentMethod: "card" as const, actionType: "AUTHORIZATION" as const, options: { card: { capture_method: "manual" } } },
      { paymentMethod: "paypal" as const, actionType: "CHARGE" as const, options: { paypal: { capture_method: undefined } } },
      { paymentMethod: "paypal" as const, actionType: "AUTHORIZATION" as const, options: { paypal: { capture_method: "manual" } } },
      { paymentMethod: "klarna" as const, actionType: "CHARGE" as const, options: { klarna: { capture_method: undefined } } },
    ])("$paymentMethod ($actionType)", async ({ paymentMethod, actionType, options }) => {
      for (const gate of [undefined, null]) {
        for (const paypalCapture of [undefined, null, "manual" as const, "automatic" as const]) {
          createMock().mockClear();

          const saleorEvent = event({ paymentMethod, actionType });

          await execute(saleorEvent, { gate, paypalCapture });

          expect(createMock().mock.calls).toStrictEqual([
            [
              {
                metadata: todaysMetadata,
                stripeMoney: StripeMoney.createFromSaleorAmount({ amount: 100, currency: "USD" })._unsafeUnwrap(),
                idempotencyKey: saleorEvent.idempotencyKey,
                intentParams: {
                  automatic_payment_methods: { enabled: true },
                  payment_method_options: options,
                },
              },
            ],
          ]);
        }
      }
    });

    it("hands out an automatic paypal PaymentIntent as today, whatever the capture mode", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(
        ok(checkout("ABSENT", [transaction(), transaction({ id: "VHJhbnNhY3Rpb25JdGVtOjEx", pspReference: "pi_auto" })])),
      );
      givenStripe(paypalOnlyIntent("pi_auto", "automatic"));

      const result = await execute(event({ paymentMethod: "paypal", existingPaymentIntentId: "pi_auto" }), {
        gate: null,
        paypalCapture: "manual",
      });

      expect(handedOut(result)).toBe("pi_auto");
    });
  });
});
