import { APL } from "@saleor/app-sdk/APL";
import { err, ok } from "neverthrow";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import {
  mockedSaleorAppId,
  mockedSaleorChannelId,
  mockedSaleorTransactionId,
} from "@/__tests__/mocks/constants";
import { mockAuthData } from "@/__tests__/mocks/mock-auth-data";
import { mockedStripePaymentIntentsApi } from "@/__tests__/mocks/mocked-stripe-payment-intents-api";
import { MockedTransactionRecorder } from "@/__tests__/mocks/mocked-transaction-recorder";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { getMockedTransactionInitializeSessionEvent } from "@/__tests__/mocks/saleor-events/transaction-initialize-session-event";
import {
  AppIsNotConfiguredResponse,
  BrokenAppResponse,
  MalformedRequestResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import { TransactionInitializeSessionEventFragment } from "@/generated/graphql";
import {
  CheckoutPaymentState,
  CheckoutPaymentStateFetcherErrors,
  CheckoutPaymentStateTransaction,
  ICheckoutPaymentStateFetcher,
} from "@/modules/saleor/checkout-payment-state-fetcher";
import { StripeAPIError } from "@/modules/stripe/stripe-api-error";
import { StripeMoney } from "@/modules/stripe/stripe-money";
import { IStripePaymentIntentsApiFactory } from "@/modules/stripe/types";
import {
  AuthorizationActionRequiredResult,
  ChargeActionRequiredResult,
} from "@/modules/transaction-result/action-required-result";
import {
  AuthorizationFailureResult,
  ChargeFailureResult,
} from "@/modules/transaction-result/failure-result";
import { TransactionRecorderError } from "@/modules/transactions-recording/repositories/transaction-recorder-repo";

import { parseTransactionInitializeSessionEventData } from "./event-data-parser";
import {
  NothingDueError,
  OtherPaymentsUnverifiedError,
  PaymentInFlightError,
  PaymentPendingError,
} from "./payment-amount-errors";
import { TransactionInitializeSessionUseCase } from "./use-case";
import { TransactionInitializeSessionUseCaseResponses } from "./use-case-response";

/*
 * The use case reads the checkout with the app token (APL + CheckoutPaymentStateFetcher)
 * to decide the amount to charge (regression NR-31). Default state: the checkout total is
 * the 100 USD the mocked event requests, and only the transaction being initialized
 * (empty) is attached, so tests that predate NR-31 keep their meaning.
 */
const mockApl = {
  get: vi.fn(),
} satisfies Pick<APL, "get">;

const mockCheckoutFetcher = {
  fetchCheckoutPaymentState: vi.fn(),
} satisfies ICheckoutPaymentStateFetcher;

const checkoutAmountDeps = {
  apl: mockApl,
  checkoutPaymentStateFetcherFactory: () => mockCheckoutFetcher,
};

const CHECKOUT_ID = "mock-channel-1"; // sourceObject.id of the mocked event
const OTHER_TRANSACTION_ID = "VHJhbnNhY3Rpb25JdGVtOjI=";

const usd = (amount: number, currency = "USD") => ({ amount, currency });

const checkoutTransaction = (
  overrides: Partial<CheckoutPaymentStateTransaction> = {},
): CheckoutPaymentStateTransaction => ({
  id: OTHER_TRANSACTION_ID,
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

const checkoutState = (overrides: Partial<CheckoutPaymentState> = {}): CheckoutPaymentState => ({
  id: CHECKOUT_ID,
  channel: { id: mockedSaleorChannelId },
  totalPrice: { gross: usd(100) },
  // Saleor creates the transaction (empty) before it calls the webhook.
  transactions: [checkoutTransaction({ id: mockedSaleorTransactionId })],
  ...overrides,
});

/*
 * The use case now updates the Saleor transaction with the Stripe PaymentIntent id
 * as pspReference (via saleorApp.apl + a GraphQL transactionUpdate mutation).
 * Mock both so unit tests don't hit the real APL / network.
 */
vi.mock("@/lib/saleor-app", () => ({
  saleorApp: {
    apl: {
      get: vi.fn(async () => ({
        token: "mocked-app-token",
        saleorApiUrl: "https://foo.bar.saleor.cloud/graphql/",
        appId: "mocked-saleor-app-id",
      })),
    },
  },
}));

vi.mock("@/lib/graphql-client", () => ({
  createInstrumentedGraphqlClient: vi.fn(() => ({
    mutation: vi.fn(async () => ({
      data: {
        transactionUpdate: {
          transaction: { id: "mocked-transaction-id" },
          errors: [],
        },
      },
    })),
  })),
}));

describe("TransactionInitializeSessionUseCase", () => {
  const stripePaymentIntentsApiFactory = {
    create: () => mockedStripePaymentIntentsApi,
  } satisfies IStripePaymentIntentsApiFactory;

  beforeEach(() => {
    /*
     * The use case first searches Stripe for existing payment intents attached to
     * the checkout (checkout-resume support). Default: none found, so tests exercise
     * the create-new-payment-intent path.
     */
    vi.mocked(mockedStripePaymentIntentsApi.searchPaymentIntentsByCheckout).mockResolvedValue(
      ok([]),
    );
    mockApl.get.mockResolvedValue(mockAuthData);
    mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(ok(checkoutState()));
  });

  it.each([
    {
      actionType: "CHARGE" as const,
      captureMethod: undefined,
    },
    {
      actionType: "AUTHORIZATION" as const,
      captureMethod: "manual",
    },
  ])(
    "Calls Stripe PaymentIntentsAPI to create payment intent with $captureMethod capture method for card when actionType is $actionType",
    async ({ actionType, captureMethod }) => {
      const saleorEvent = getMockedTransactionInitializeSessionEvent({ actionType });

      const spy = vi
        .spyOn(mockedStripePaymentIntentsApi, "createPaymentIntent")
        .mockImplementationOnce(async () =>
          ok({
            amount: 100,
            currency: "usd",
            client_secret: "secret-value",
            id: "pi_test",
            status: "requires_payment_method",
          } as Stripe.PaymentIntent),
        );

      const uc = new TransactionInitializeSessionUseCase({
        appConfigRepo: mockedAppConfigRepo,
        stripePaymentIntentsApiFactory,
        transactionRecorder: new MockedTransactionRecorder(),
        ...checkoutAmountDeps,
      });

      await uc.execute({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        event: saleorEvent,
      });

      expect(spy).toHaveBeenCalledWith({
        stripeMoney: expect.any(StripeMoney),
        idempotencyKey: saleorEvent.idempotencyKey,
        intentParams: {
          automatic_payment_methods: {
            enabled: true,
          },
          payment_method_options: {
            card: {
              capture_method: captureMethod,
            },
          },
        },
        metadata: {
          saleor_source_id: saleorEvent.sourceObject.id,
          saleor_source_type: saleorEvent.sourceObject.__typename,
          saleor_transaction_id: saleorEvent.transaction.id,
        },
      });

      expect(spy.mock.calls[0][0].stripeMoney.amount).toBe(10000);
      expect(spy.mock.calls[0][0].stripeMoney.currency).toBe("usd");
    },
  );

  it.each([
    {
      actionType: "CHARGE" as const,
      expectedSuccessResponse: TransactionInitializeSessionUseCaseResponses.Success,
      expectedResultType: ChargeActionRequiredResult,
    },
    {
      actionType: "AUTHORIZATION" as const,
      expectedSuccessResponse: TransactionInitializeSessionUseCaseResponses.Success,
      expectedResultType: AuthorizationActionRequiredResult,
    },
  ])(
    "Returns $expectedSuccessResponse.name response with $expectedResultType.name result if Stripe PaymentIntentsAPI successfully responds and actionType is $actionType",
    async ({ actionType, expectedSuccessResponse, expectedResultType }) => {
      const saleorEvent = getMockedTransactionInitializeSessionEvent({ actionType });

      vi.spyOn(mockedStripePaymentIntentsApi, "createPaymentIntent").mockImplementationOnce(
        async () =>
          ok({
            amount: 100,
            currency: "usd",
            client_secret: "secret-value",
            id: "pi_test",
            status: "requires_payment_method",
          } as Stripe.PaymentIntent),
      );
      const uc = new TransactionInitializeSessionUseCase({
        appConfigRepo: mockedAppConfigRepo,
        stripePaymentIntentsApiFactory,
        transactionRecorder: new MockedTransactionRecorder(),
        ...checkoutAmountDeps,
      });

      const responsePayload = await uc.execute({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        event: saleorEvent,
      });

      expect(responsePayload._unsafeUnwrap()).toBeInstanceOf(expectedSuccessResponse);
      expect(responsePayload._unsafeUnwrap().transactionResult).toBeInstanceOf(expectedResultType);
    },
  );

  it("Returns 'MissingConfigErrorResponse' if config not found for specified channel", async () => {
    const spy = vi
      .spyOn(mockedAppConfigRepo, "getStripeConfig")
      .mockImplementationOnce(async () => ok(null));

    const uc = new TransactionInitializeSessionUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripePaymentIntentsApiFactory,
      transactionRecorder: new MockedTransactionRecorder(),
      ...checkoutAmountDeps,
    });

    const responsePayload = await uc.execute({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      event: getMockedTransactionInitializeSessionEvent(),
    });

    const err = responsePayload._unsafeUnwrapErr();

    expect(spy).toHaveBeenCalledOnce();

    expect(err).toBeInstanceOf(AppIsNotConfiguredResponse);
  });

  it.each([
    {
      actionType: "CHARGE" as const,
      expectedFailureResponse: TransactionInitializeSessionUseCaseResponses.Failure,
      expectedResultType: ChargeFailureResult,
    },
    {
      actionType: "AUTHORIZATION" as const,
      expectedFailureResponse: TransactionInitializeSessionUseCaseResponses.Failure,
      expectedResultType: AuthorizationFailureResult,
    },
  ])(
    "Returns $expectedFailureResponse.name response with $expectedResultType.name result if StripePaymentIntentsAPI throws error and actionType is $actionType",
    async ({ actionType, expectedFailureResponse, expectedResultType }) => {
      vi.spyOn(mockedStripePaymentIntentsApi, "createPaymentIntent").mockImplementationOnce(
        async () => err(new StripeAPIError("Error from Stripe API")),
      );

      const uc = new TransactionInitializeSessionUseCase({
        appConfigRepo: mockedAppConfigRepo,
        stripePaymentIntentsApiFactory,
        transactionRecorder: new MockedTransactionRecorder(),
        ...checkoutAmountDeps,
      });

      const saleorEvent = getMockedTransactionInitializeSessionEvent({ actionType });

      const responsePayload = await uc.execute({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        event: saleorEvent,
      });

      expect(responsePayload._unsafeUnwrap()).toBeInstanceOf(expectedFailureResponse);
      expect(responsePayload._unsafeUnwrap().transactionResult).toBeInstanceOf(expectedResultType);
    },
  );

  it.each([
    {
      actionType: "CHARGE" as const,
      expectedFailureResponse: TransactionInitializeSessionUseCaseResponses.Failure,
      expectedResultType: ChargeFailureResult,
    },
    {
      actionType: "AUTHORIZATION" as const,
      expectedFailureResponse: TransactionInitializeSessionUseCaseResponses.Failure,
      expectedResultType: AuthorizationFailureResult,
    },
  ])(
    "Returns $expectedFailureResponse.name response with $expectedResultType.name result when receives not supported payment method in data and actionType is $actionType",
    async ({ actionType, expectedFailureResponse, expectedResultType }) => {
      const eventWithNotSupportedPaymentMethod = {
        ...getMockedTransactionInitializeSessionEvent({ actionType }),
        data: {
          paymentIntent: {
            paymentMethod: "not-supported-payment-method",
          },
        },
      };

      const uc = new TransactionInitializeSessionUseCase({
        appConfigRepo: mockedAppConfigRepo,
        stripePaymentIntentsApiFactory,
        transactionRecorder: new MockedTransactionRecorder(),
        ...checkoutAmountDeps,
      });

      const responsePayload = await uc.execute({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        event: eventWithNotSupportedPaymentMethod,
      });

      expect(responsePayload._unsafeUnwrap()).toBeInstanceOf(expectedFailureResponse);
      expect(responsePayload._unsafeUnwrap().transactionResult).toBeInstanceOf(expectedResultType);
    },
  );

  it.each([
    {
      actionType: "CHARGE" as const,
      expectedFailureResponse: TransactionInitializeSessionUseCaseResponses.Failure,
      expectedResultType: ChargeFailureResult,
    },
    {
      actionType: "AUTHORIZATION" as const,
      expectedFailureResponse: TransactionInitializeSessionUseCaseResponses.Failure,
      expectedResultType: AuthorizationFailureResult,
    },
  ])(
    "Returns $expectedFailureResponse.name response with $expectedResultType.name result when receives additional field in data and actionType is $actionType",
    async ({ actionType, expectedFailureResponse, expectedResultType }) => {
      const eventWithAdditionalFieldinData = {
        ...getMockedTransactionInitializeSessionEvent({ actionType }),
        data: {
          paymentIntent: {
            paymentMethod: "card",
            addtionalField: "value",
          },
        },
      };

      const uc = new TransactionInitializeSessionUseCase({
        appConfigRepo: mockedAppConfigRepo,
        stripePaymentIntentsApiFactory,
        transactionRecorder: new MockedTransactionRecorder(),
        ...checkoutAmountDeps,
      });

      const responsePayload = await uc.execute({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        event: eventWithAdditionalFieldinData,
      });

      expect(responsePayload._unsafeUnwrap()).toBeInstanceOf(expectedFailureResponse);
      expect(responsePayload._unsafeUnwrap().transactionResult).toBeInstanceOf(expectedResultType);
    },
  );

  it("Returns 'MalformedRequestResponse' when currency coming from Saleor is not supported", async () => {
    const saleorEvent = {
      ...getMockedTransactionInitializeSessionEvent(),
      action: {
        amount: 100,
        currency: "ABC",
        actionType: "CHARGE" as const,
      },
    };

    const uc = new TransactionInitializeSessionUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripePaymentIntentsApiFactory,
      transactionRecorder: new MockedTransactionRecorder(),
      ...checkoutAmountDeps,
    });

    const result = await uc.execute({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      event: saleorEvent,
    });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MalformedRequestResponse);
  });

  it("Returns 'BrokenAppResponse' when currency coming from Stripe is not supported", async () => {
    const saleorEvent = getMockedTransactionInitializeSessionEvent();

    vi.spyOn(mockedStripePaymentIntentsApi, "createPaymentIntent").mockImplementationOnce(
      async () =>
        ok({
          amount: 100,
          currency: "abc",
          status: "requires_payment_method",
        } as Stripe.PaymentIntent),
    );

    const uc = new TransactionInitializeSessionUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripePaymentIntentsApiFactory,
      transactionRecorder: new MockedTransactionRecorder(),
      ...checkoutAmountDeps,
    });

    const result = await uc.execute({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      event: saleorEvent,
    });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BrokenAppResponse);
  });

  it("Returns 'BrokenAppResponse' when Stripe PaymentIntentsAPI didn't returned required client_secret field", async () => {
    const saleorEvent = getMockedTransactionInitializeSessionEvent();

    vi.spyOn(mockedStripePaymentIntentsApi, "createPaymentIntent").mockImplementationOnce(
      async () =>
        ok({
          amount: 100,
          currency: "usd",
          id: "pi_test",
          status: "requires_payment_method",
        } as Stripe.PaymentIntent),
    );

    const uc = new TransactionInitializeSessionUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripePaymentIntentsApiFactory,
      transactionRecorder: new MockedTransactionRecorder(),
      ...checkoutAmountDeps,
    });

    const result = await uc.execute({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      event: saleorEvent,
    });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BrokenAppResponse);
  });

  it("Returns 'BrokenAppResponse' when Stripe PaymentIntentsAPI didn't returned required payment id", async () => {
    const saleorEvent = getMockedTransactionInitializeSessionEvent();

    vi.spyOn(mockedStripePaymentIntentsApi, "createPaymentIntent").mockImplementationOnce(
      async () =>
        ok({
          amount: 100,
          currency: "usd",
          client_secret: "secret-value",
          status: "requires_payment_method",
        } as Stripe.PaymentIntent),
    );

    const uc = new TransactionInitializeSessionUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripePaymentIntentsApiFactory,
      transactionRecorder: new MockedTransactionRecorder(),
      ...checkoutAmountDeps,
    });

    const result = await uc.execute({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      event: saleorEvent,
    });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BrokenAppResponse);
  });

  it("Returns 'BrokenAppResponse' when TransactionRecorderRepo returns error", async () => {
    const saleorEvent = getMockedTransactionInitializeSessionEvent();
    const transactionRecorder = new MockedTransactionRecorder();

    vi.spyOn(transactionRecorder, "recordTransaction").mockImplementationOnce(async () =>
      err(new TransactionRecorderError.TransactionMissingError("Transaction recorder error")),
    );

    vi.spyOn(mockedStripePaymentIntentsApi, "createPaymentIntent").mockImplementationOnce(
      async () =>
        ok({
          amount: 100,
          currency: "usd",
          client_secret: "secret-value",
          status: "requires_payment_method",
        } as Stripe.PaymentIntent),
    );

    const uc = new TransactionInitializeSessionUseCase({
      appConfigRepo: mockedAppConfigRepo,
      stripePaymentIntentsApiFactory,
      transactionRecorder,
      ...checkoutAmountDeps,
    });

    const result = await uc.execute({
      saleorApiUrl: mockedSaleorApiUrl,
      appId: mockedSaleorAppId,
      event: saleorEvent,
    });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BrokenAppResponse);
  });

  it.each([
    {
      actionType: "CHARGE" as const,
    },
    {
      actionType: "AUTHORIZATION" as const,
    },
  ])(
    "Calls TransactionRecorderRepo with resolved data when handling $actionType action",
    async ({ actionType }) => {
      const saleorEvent = getMockedTransactionInitializeSessionEvent({ actionType });
      const transactionRecorder = new MockedTransactionRecorder();

      vi.spyOn(transactionRecorder, "recordTransaction");

      vi.spyOn(mockedStripePaymentIntentsApi, "createPaymentIntent").mockImplementation(async () =>
        ok({
          amount: 100,
          currency: "usd",
          client_secret: "secret-value",
          id: "pi_test",
          status: "requires_payment_method",
        } as Stripe.PaymentIntent),
      );

      const uc = new TransactionInitializeSessionUseCase({
        appConfigRepo: mockedAppConfigRepo,
        stripePaymentIntentsApiFactory,
        transactionRecorder,
        ...checkoutAmountDeps,
      });

      await uc.execute({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        event: saleorEvent,
      });

      expect(transactionRecorder.recordTransaction).toHaveBeenCalledWith(
        {
          saleorApiUrl: mockedSaleorApiUrl,
          appId: mockedSaleorAppId,
        },
        {
          resolvedTransactionFlow: actionType,
          saleorTransactionFlow: actionType,
          saleorTransactionId: "mocked-transaction-id",
          selectedPaymentMethod: "card",
          stripePaymentIntentId: "pi_test",
        },
      );
    },
  );

  /*
   * Regression NR-31 (payments review 2026-10-21, A2b): Saleor forwards the caller's
   * `transactionInitialize(amount:)` as-is, so the amount must come from the checkout.
   */
  describe("amount charged comes from the Saleor checkout (NR-31)", () => {
    const createUseCase = () =>
      new TransactionInitializeSessionUseCase({
        appConfigRepo: mockedAppConfigRepo,
        stripePaymentIntentsApiFactory,
        transactionRecorder: new MockedTransactionRecorder(),
        ...checkoutAmountDeps,
      });

    const paymentIntent = (overrides: Partial<Stripe.PaymentIntent> = {}) =>
      ({
        id: "pi_created",
        object: "payment_intent",
        amount: 100_00,
        amount_received: 0,
        amount_capturable: 0,
        currency: "usd",
        status: "requires_payment_method",
        client_secret: "pi_created_secret_test",
        metadata: {
          saleor_source_id: CHECKOUT_ID,
          saleor_source_type: "Checkout",
          saleor_transaction_id: mockedSaleorTransactionId,
        },
        ...overrides,
      }) as Stripe.PaymentIntent;

    const event = (args: {
      amount: number;
      existingPaymentIntentId?: string;
      sourceType?: "Checkout" | "Order";
    }): TransactionInitializeSessionEventFragment => {
      const base = getMockedTransactionInitializeSessionEvent();

      return {
        ...base,
        action: { amount: args.amount, currency: "USD", actionType: "CHARGE" },
        data: parseTransactionInitializeSessionEventData({
          paymentIntent: { paymentMethod: "card" },
          ...(args.existingPaymentIntentId
            ? { existingPaymentIntentId: args.existingPaymentIntentId }
            : {}),
        })._unsafeUnwrap(),
        sourceObject: { ...base.sourceObject, __typename: args.sourceType ?? "Checkout" },
      };
    };

    const execute = (saleorEvent: TransactionInitializeSessionEventFragment) =>
      createUseCase().execute({
        saleorApiUrl: mockedSaleorApiUrl,
        appId: mockedSaleorAppId,
        event: saleorEvent,
      });

    const createMock = () => vi.mocked(mockedStripePaymentIntentsApi.createPaymentIntent);
    const updateMock = () => vi.mocked(mockedStripePaymentIntentsApi.updatePaymentIntent);
    const getMock = () => vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent);
    const searchMock = () =>
      vi.mocked(mockedStripePaymentIntentsApi.searchPaymentIntentsByCheckout);
    const cancelMock = () => vi.mocked(mockedStripePaymentIntentsApi.cancelPaymentIntent);

    const givenCheckout = (state: CheckoutPaymentState | null) =>
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(ok(state));

    const expectNoStripeCall = () => {
      expect(createMock()).not.toHaveBeenCalled();
      expect(updateMock()).not.toHaveBeenCalled();
      expect(getMock()).not.toHaveBeenCalled();
      expect(searchMock()).not.toHaveBeenCalled();
      expect(cancelMock()).not.toHaveBeenCalled();
    };

    const expectChargeFailure = (
      result: Awaited<ReturnType<TransactionInitializeSessionUseCase["execute"]>>,
    ) => {
      const response = result._unsafeUnwrap();

      expect(response).toBeInstanceOf(TransactionInitializeSessionUseCaseResponses.Failure);
      expect(response.transactionResult).toBeInstanceOf(ChargeFailureResult);
    };

    beforeEach(() => {
      createMock().mockImplementation(async (args) =>
        ok(
          paymentIntent({
            amount: args.stripeMoney.amount,
            currency: args.stripeMoney.currency,
          }),
        ),
      );
      updateMock().mockImplementation(async (args) =>
        ok(
          paymentIntent({
            id: args.id,
            amount: args.stripeMoney.amount,
            currency: args.stripeMoney.currency,
            client_secret: `${args.id}_secret_test`,
          }),
        ),
      );
    });

    describe("clamps to the checkout balance", () => {
      it.each([0.5, 99.99, 5000])(
        "creates the PaymentIntent for the checkout total when the caller asks for %s",
        async (requested) => {
          const result = await execute(event({ amount: requested }));

          expect(createMock()).toHaveBeenCalledOnce();
          expect(createMock().mock.calls[0][0].stripeMoney.amount).toBe(100_00);

          const response = result._unsafeUnwrap();

          expect(response).toBeInstanceOf(TransactionInitializeSessionUseCaseResponses.Success);
          // The response amount is what Saleor records on the transaction event.
          expect(
            response instanceof TransactionInitializeSessionUseCaseResponses.Success &&
              response.saleorMoney.amount,
          ).toBe(100);
        },
      );

      it("uses totalPrice, which Saleor already nets of vouchers and gift cards", async () => {
        // Gross 120, voucher -20, gift card -20: Saleor's totalPrice is 80. Its default
        // transactionInitialize amount (no `amount:`) would be 100 (before gift cards).
        givenCheckout(checkoutState({ totalPrice: { gross: usd(80) } }));

        const result = await execute(event({ amount: 100 }));

        expect(createMock().mock.calls[0][0].stripeMoney.amount).toBe(80_00);

        const response = result._unsafeUnwrap();

        expect(
          response instanceof TransactionInitializeSessionUseCaseResponses.Success &&
            response.saleorMoney.amount,
        ).toBe(80);
      });

      it("subtracts money other transactions of the checkout already hold", async () => {
        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              checkoutTransaction({ pspReference: "pi_paid", chargedAmount: usd(40.1) }),
              checkoutTransaction({
                id: "VHJhbnNhY3Rpb25JdGVtOjM=",
                authorizedAmount: usd(10.05),
              }),
            ],
          }),
        );
        // pi_paid is listed on a Saleor transaction, so the app reads it: paid and recorded.
        getMock().mockImplementation(async ({ id }) =>
          ok(paymentIntent({ id, status: "succeeded", amount: 40_10 })),
        );

        const result = await execute(event({ amount: 100 }));

        expect(createMock().mock.calls[0][0].stripeMoney.amount).toBe(49_85);

        const response = result._unsafeUnwrap();

        expect(
          response instanceof TransactionInitializeSessionUseCaseResponses.Success &&
            response.saleorMoney.amount,
        ).toBe(49.85);
      });

      it("updates the storefront's PaymentIntent to the balance, not to the caller amount", async () => {
        getMock().mockResolvedValue(ok(paymentIntent({ id: "pi_existing", amount: 50 })));

        const result = await execute(
          event({ amount: 0.5, existingPaymentIntentId: "pi_existing" }),
        );

        expect(updateMock()).toHaveBeenCalledOnce();
        expect(updateMock().mock.calls[0][0].id).toBe("pi_existing");
        expect(updateMock().mock.calls[0][0].stripeMoney.amount).toBe(100_00);
        expect(createMock()).not.toHaveBeenCalled();

        const response = result._unsafeUnwrap();

        expect(
          response instanceof TransactionInitializeSessionUseCaseResponses.Success &&
            response.saleorMoney.amount,
        ).toBe(100);
      });

      it("reuses a PaymentIntent found for the checkout only at the balance amount", async () => {
        searchMock().mockResolvedValue(ok([paymentIntent({ id: "pi_found", amount: 50 })]));

        await execute(event({ amount: 0.5 }));

        // 0.50 must not match the 0.50 PaymentIntent: it is updated to the balance instead.
        expect(updateMock()).toHaveBeenCalledOnce();
        expect(updateMock().mock.calls[0][0].id).toBe("pi_found");
        expect(updateMock().mock.calls[0][0].stripeMoney.amount).toBe(100_00);
      });
    });

    /*
     * A pending payment or a fully paid checkout refuses too, but only after the checkout's
     * other payable PaymentIntents are closed (round 2): see "refuses once nothing is left
     * to pay or a payment is pending" below.
     */
    describe("refuses without calling Stripe", () => {
      it("when the checkout currency differs from the requested currency", async () => {
        givenCheckout(checkoutState({ totalPrice: { gross: usd(100, "EUR") } }));

        const result = await execute(event({ amount: 100 }));

        expectChargeFailure(result);
        expectNoStripeCall();
      });

      it("when another transaction holds money in another currency", async () => {
        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              checkoutTransaction({ chargedAmount: usd(10, "EUR") }),
            ],
          }),
        );

        const result = await execute(event({ amount: 100 }));

        expectChargeFailure(result);
        expectNoStripeCall();
      });

      it("when Saleor no longer has the checkout", async () => {
        givenCheckout(null);

        const result = await execute(event({ amount: 100 }));

        expectChargeFailure(result);
        expectNoStripeCall();
      });

      it("returns BrokenAppResponse when the checkout cannot be read from Saleor", async () => {
        mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(
          err(new CheckoutPaymentStateFetcherErrors.FetchError("saleor down")),
        );

        const result = await execute(event({ amount: 100 }));

        expect(result._unsafeUnwrapErr()).toBeInstanceOf(BrokenAppResponse);
        expectNoStripeCall();
      });

      it("returns BrokenAppResponse when the app token is missing", async () => {
        mockApl.get.mockResolvedValue(undefined);

        const result = await execute(event({ amount: 100 }));

        expect(result._unsafeUnwrapErr()).toBeInstanceOf(BrokenAppResponse);
        expect(mockCheckoutFetcher.fetchCheckoutPaymentState).not.toHaveBeenCalled();
        expectNoStripeCall();
      });
    });

    describe("existingPaymentIntentId is honoured only for this checkout", () => {
      it.each<{ case: string; metadata: Stripe.Metadata }>([
        {
          case: "another checkout",
          metadata: { saleor_source_id: "Q2hlY2tvdXQ6OTk5", saleor_source_type: "Checkout" },
        },
        {
          case: "an order",
          metadata: { saleor_source_id: CHECKOUT_ID, saleor_source_type: "Order" },
        },
        { case: "no Saleor metadata", metadata: {} },
      ])("never updates a PaymentIntent of $case, creates one instead", async ({ metadata }) => {
        getMock().mockResolvedValue(ok(paymentIntent({ id: "pi_foreign", amount: 50, metadata })));

        const result = await execute(event({ amount: 100, existingPaymentIntentId: "pi_foreign" }));

        expect(updateMock()).not.toHaveBeenCalled();
        expect(cancelMock()).not.toHaveBeenCalled();
        expect(createMock()).toHaveBeenCalledOnce();
        expect(createMock().mock.calls[0][0].stripeMoney.amount).toBe(100_00);
        expect(result._unsafeUnwrap()).toBeInstanceOf(
          TransactionInitializeSessionUseCaseResponses.Success,
        );
      });

      it("ignores a PaymentIntent Stripe cannot find and creates one", async () => {
        getMock().mockResolvedValue(err(new StripeAPIError("No such payment_intent")));

        await execute(event({ amount: 100, existingPaymentIntentId: "pi_unknown" }));

        expect(updateMock()).not.toHaveBeenCalled();
        expect(createMock()).toHaveBeenCalledOnce();
      });

      it.each(["processing", "requires_capture", "succeeded"] as const)(
        "refuses while this checkout's PaymentIntent is %s and Saleor has not recorded it",
        async (status) => {
          getMock().mockResolvedValue(ok(paymentIntent({ id: "pi_existing", status })));
          updateMock().mockResolvedValue(err(new StripeAPIError("cannot update")));

          const result = await execute(
            event({ amount: 100, existingPaymentIntentId: "pi_existing" }),
          );

          expectChargeFailure(result);
          expect(updateMock()).not.toHaveBeenCalled();
          expect(createMock()).not.toHaveBeenCalled();
        },
      );

      it("starts a PaymentIntent for the rest once the earlier one is paid and recorded", async () => {
        getMock().mockResolvedValue(
          ok(paymentIntent({ id: "pi_paid", status: "succeeded", amount: 40_10 })),
        );
        updateMock().mockResolvedValue(err(new StripeAPIError("cannot update")));
        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              checkoutTransaction({ pspReference: "pi_paid", chargedAmount: usd(40.1) }),
            ],
          }),
        );

        await execute(event({ amount: 100, existingPaymentIntentId: "pi_paid" }));

        expect(updateMock()).not.toHaveBeenCalled();
        expect(createMock()).toHaveBeenCalledOnce();
        expect(createMock().mock.calls[0][0].stripeMoney.amount).toBe(59_90);
      });

      it("refuses instead of creating a new PaymentIntent when a found one cannot be cancelled because it is processing", async () => {
        // Stripe's search index can lag: it still lists the PaymentIntent as requires_payment_method.
        searchMock().mockResolvedValue(
          ok([paymentIntent({ id: "pi_stale", amount: 50, currency: "eur" })]),
        );
        cancelMock().mockResolvedValue(err(new StripeAPIError("cannot cancel processing")));
        getMock().mockResolvedValue(ok(paymentIntent({ id: "pi_stale", status: "processing" })));

        const result = await execute(event({ amount: 100 }));

        expectChargeFailure(result);
        expect(createMock()).not.toHaveBeenCalled();
      });
    });

    /*
     * In-memory Stripe for the tests below: the statuses in which Stripe accepts a cancel
     * or an amount update, and "resource_missing" for an unknown PaymentIntent.
     */
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

    const resourceMissing = (id: string) =>
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        code: "resource_missing",
        message: `No such payment_intent: '${id}'`,
      });

    const givenStripe = (...intents: Stripe.PaymentIntent[]) => {
      const byId = new Map(intents.map((pi) => [pi.id, pi]));

      getMock().mockImplementation(async ({ id }) => {
        const pi = byId.get(id);

        return pi ? ok(pi) : err(resourceMissing(id));
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
        };

        byId.set(args.id, updated);

        return ok(updated);
      });

      return byId;
    };

    const ownIntent = (
      id: string,
      transactionId: string,
      overrides: Partial<Stripe.PaymentIntent> = {},
    ) =>
      paymentIntent({
        id,
        client_secret: `${id}_secret_test`,
        metadata: {
          saleor_source_id: CHECKOUT_ID,
          saleor_source_type: "Checkout",
          saleor_transaction_id: transactionId,
        },
        ...overrides,
      });

    const failureError = (
      result: Awaited<ReturnType<TransactionInitializeSessionUseCase["execute"]>>,
    ) => {
      const response = result._unsafeUnwrap();

      expect(response).toBeInstanceOf(TransactionInitializeSessionUseCaseResponses.Failure);

      return response instanceof TransactionInitializeSessionUseCaseResponses.Failure
        ? response.error
        : undefined;
    };

    const handedOut = (
      result: Awaited<ReturnType<TransactionInitializeSessionUseCase["execute"]>>,
    ) => {
      const response = result._unsafeUnwrap();

      expect(response).toBeInstanceOf(TransactionInitializeSessionUseCaseResponses.Success);

      return response instanceof TransactionInitializeSessionUseCaseResponses.Success
        ? response.stripePaymentIntentId
        : undefined;
    };

    const cancelledIds = () => cancelMock().mock.calls.map(([args]) => args.id);

    const TX_1 = "VHJhbnNhY3Rpb25JdGVtOjEx";
    const TX_2 = "VHJhbnNhY3Rpb25JdGVtOjEy";

    /*
     * Review M1 (payments review 2026-10-22): a PaymentIntent was handed out without
     * cancelling the checkout's other ones on two of three paths, and a failed Stripe search
     * created a new one blind. Two tabs: PI_1 and PI_2 exist, PI_2 is paid before Stripe's
     * event reaches Saleor, tab B re-initializes naming PI_1 -> PI_1 is paid too.
     * A cancelled PaymentIntent can never be confirmed, so cancelling the others before
     * handing one out is the guard; one that is already paid and unrecorded blocks.
     */
    describe("other PaymentIntents of the checkout (M1)", () => {
      const twoTabs = () =>
        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              checkoutTransaction({ id: TX_1, pspReference: "pi_1" }),
              checkoutTransaction({ id: TX_2, pspReference: "pi_2" }),
            ],
          }),
        );

      it("refuses to hand out the storefront's PaymentIntent while another one is paid but not recorded, and cancels it", async () => {
        twoTabs();
        givenStripe(ownIntent("pi_1", TX_1), ownIntent("pi_2", TX_2, { status: "succeeded" }));

        const result = await execute(event({ amount: 100, existingPaymentIntentId: "pi_1" }));

        expect(failureError(result)).toBeInstanceOf(PaymentInFlightError);
        expect(updateMock()).not.toHaveBeenCalled();
        expect(createMock()).not.toHaveBeenCalled();
        // The other tab still holds pi_1: it must not be payable either.
        expect(cancelledIds()).toContain("pi_1");
      });

      it("cancels the checkout's other open PaymentIntents before handing out the storefront's one", async () => {
        twoTabs();
        givenStripe(
          ownIntent("pi_1", TX_1),
          ownIntent("pi_2", TX_2, { status: "requires_action" }),
        );

        const result = await execute(event({ amount: 100, existingPaymentIntentId: "pi_1" }));

        expect(handedOut(result)).toBe("pi_1");
        expect(cancelledIds()).toStrictEqual(["pi_2"]);
      });

      it("hands out a verified storefront PaymentIntent without the Stripe search", async () => {
        twoTabs();
        givenStripe(ownIntent("pi_1", TX_1), ownIntent("pi_2", TX_2, { status: "canceled" }));
        searchMock().mockResolvedValue(err(new StripeAPIError("search unavailable")));

        const result = await execute(event({ amount: 100, existingPaymentIntentId: "pi_1" }));

        expect(handedOut(result)).toBe("pi_1");
        expect(searchMock()).not.toHaveBeenCalled();
      });

      it("cancels the other open PaymentIntents when it refuses because the storefront's one is already paid", async () => {
        twoTabs();
        givenStripe(ownIntent("pi_1", TX_1), ownIntent("pi_2", TX_2, { status: "succeeded" }));

        const result = await execute(event({ amount: 100, existingPaymentIntentId: "pi_2" }));

        expect(failureError(result)).toBeInstanceOf(PaymentInFlightError);
        expect(cancelledIds()).toStrictEqual(["pi_1"]);
        expect(createMock()).not.toHaveBeenCalled();
      });

      it("reuses an exact-amount PaymentIntent found by search only after cancelling the checkout's other ones", async () => {
        const exact = ownIntent("pi_exact", TX_1);
        const old = ownIntent("pi_old", TX_2, { amount: 50 });

        givenStripe(exact, old);
        searchMock().mockResolvedValue(ok([exact, old]));

        const result = await execute(event({ amount: 100 }));

        expect(handedOut(result)).toBe("pi_exact");
        expect(cancelledIds()).toStrictEqual(["pi_old"]);
      });

      it("refuses to reuse an exact-amount PaymentIntent while another one is paid but not recorded", async () => {
        const exact = ownIntent("pi_exact", TX_1);

        twoTabs();
        givenStripe(exact, ownIntent("pi_2", TX_2, { status: "succeeded" }));
        searchMock().mockResolvedValue(ok([exact]));

        const result = await execute(event({ amount: 100 }));

        expect(failureError(result)).toBeInstanceOf(PaymentInFlightError);
        expect(cancelledIds()).toContain("pi_exact");
        expect(createMock()).not.toHaveBeenCalled();
      });

      it("updates a found PaymentIntent only after cancelling the checkout's other ones", async () => {
        const found = ownIntent("pi_found", TX_1, { amount: 50 });

        twoTabs();
        givenStripe(found, ownIntent("pi_2", TX_2));
        searchMock().mockResolvedValue(ok([found]));

        const result = await execute(event({ amount: 100 }));

        expect(handedOut(result)).toBe("pi_found");
        expect(cancelledIds()).toStrictEqual(["pi_2"]);
      });

      it("refuses to create a PaymentIntent while one known only to Saleor is paid but not recorded", async () => {
        // The Stripe search only lists requires_payment_method intents: pi_2 is found through Saleor.
        twoTabs();
        givenStripe(ownIntent("pi_1", TX_1), ownIntent("pi_2", TX_2, { status: "processing" }));

        const result = await execute(event({ amount: 100 }));

        expect(failureError(result)).toBeInstanceOf(PaymentInFlightError);
        expect(createMock()).not.toHaveBeenCalled();
        expect(cancelledIds()).toContain("pi_1");
      });

      it("never cancels a PaymentIntent whose authorization Saleor recorded, and charges the rest", async () => {
        // Stripe's search index lags: it still lists the authorized intent as requires_payment_method.
        const authorized = ownIntent("pi_auth", TX_2, { amount: 40_00 });

        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              checkoutTransaction({ id: TX_2, pspReference: "pi_auth", authorizedAmount: usd(40) }),
            ],
          }),
        );
        givenStripe({ ...authorized, status: "requires_capture" });
        searchMock().mockResolvedValue(ok([authorized]));

        const result = await execute(event({ amount: 100 }));

        expect(cancelledIds()).not.toContain("pi_auth");
        expect(createMock()).toHaveBeenCalledOnce();
        expect(createMock().mock.calls[0][0].stripeMoney.amount).toBe(60_00);
        expect(result._unsafeUnwrap()).toBeInstanceOf(
          TransactionInitializeSessionUseCaseResponses.Success,
        );
      });

      /*
       * Review round 2 (Q1): every PaymentIntent a shopper can pay is listed on the checkout's
       * Saleor transactions, so a failed search no longer blocks the payment: the app closes
       * those and goes on.
       */
      it("creates a PaymentIntent when the Stripe search fails, after closing the ones listed on the checkout", async () => {
        twoTabs();
        givenStripe(
          ownIntent("pi_1", TX_1),
          ownIntent("pi_2", TX_2, { status: "requires_action" }),
        );
        searchMock().mockResolvedValue(err(new StripeAPIError("search unavailable")));

        const result = await execute(event({ amount: 100 }));

        expect(handedOut(result)).toBe("pi_created");
        expect(createMock()).toHaveBeenCalledOnce();
        expect([...cancelledIds()].sort()).toStrictEqual(["pi_1", "pi_2"]);
      });

      it("still refuses after a failed Stripe search when a listed PaymentIntent is paid but not recorded", async () => {
        twoTabs();
        givenStripe(ownIntent("pi_1", TX_1), ownIntent("pi_2", TX_2, { status: "succeeded" }));
        searchMock().mockResolvedValue(err(new StripeAPIError("search unavailable")));

        const result = await execute(event({ amount: 100 }));

        expect(failureError(result)).toBeInstanceOf(PaymentInFlightError);
        expect(createMock()).not.toHaveBeenCalled();
      });

      it("still refuses after a failed Stripe search when a listed PaymentIntent can be neither read nor cancelled", async () => {
        twoTabs();
        getMock().mockResolvedValue(err(new StripeAPIError("Stripe unavailable")));
        cancelMock().mockResolvedValue(err(new StripeAPIError("Stripe unavailable")));
        searchMock().mockResolvedValue(err(new StripeAPIError("search unavailable")));

        const result = await execute(event({ amount: 100 }));

        expect(failureError(result)).toBeInstanceOf(OtherPaymentsUnverifiedError);
        expect(createMock()).not.toHaveBeenCalled();
      });

      it("refuses when another PaymentIntent of the checkout can be neither checked nor cancelled", async () => {
        twoTabs();
        getMock().mockResolvedValue(err(new StripeAPIError("Stripe unavailable")));
        cancelMock().mockResolvedValue(err(new StripeAPIError("Stripe unavailable")));

        const result = await execute(event({ amount: 100 }));

        expect(failureError(result)).toBeInstanceOf(OtherPaymentsUnverifiedError);
        expect(createMock()).not.toHaveBeenCalled();
      });

      it("ignores a Saleor pspReference that this Stripe account does not know", async () => {
        // e.g. a test-mode PaymentIntent left on the checkout before the live keys were set.
        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              checkoutTransaction({ id: TX_2, pspReference: "pi_other_account" }),
            ],
          }),
        );
        givenStripe();

        const result = await execute(event({ amount: 100 }));

        expect(createMock()).toHaveBeenCalledOnce();
        expect(result._unsafeUnwrap()).toBeInstanceOf(
          TransactionInitializeSessionUseCaseResponses.Success,
        );
      });

      it("ignores Saleor pspReferences that are not Stripe PaymentIntents", async () => {
        // e.g. a bank-transfer transaction of another payment app.
        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              checkoutTransaction({ id: TX_2, pspReference: "virement-1042" }),
            ],
          }),
        );
        givenStripe();

        await execute(event({ amount: 100 }));

        expect(getMock()).not.toHaveBeenCalled();
        expect(createMock()).toHaveBeenCalledOnce();
      });
    });

    /*
     * Review M2 (payments review 2026-10-22): "recorded" meant "a transaction still holds
     * money". After a full refund (or a chargeback) Saleor's charged amount is 0 while the
     * PaymentIntent stays `succeeded`, so every new initialize was refused forever.
     */
    describe("a refunded or charged-back payment does not block the checkout (M2)", () => {
      it.each<{ case: string; recorded: Partial<CheckoutPaymentStateTransaction> }>([
        {
          case: "fully refunded",
          recorded: {
            refundedAmount: usd(100),
            events: [{ type: "CHARGE_SUCCESS" }, { type: "REFUND_SUCCESS" }],
          },
        },
        {
          case: "being refunded",
          recorded: { refundPendingAmount: usd(100), events: [{ type: "CHARGE_SUCCESS" }] },
        },
        {
          case: "charged back",
          recorded: { events: [{ type: "CHARGE_SUCCESS" }, { type: "CHARGE_BACK" }] },
        },
      ])("starts a new PaymentIntent when the earlier paid one was $case", async ({ recorded }) => {
        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              checkoutTransaction({ id: TX_1, pspReference: "pi_paid", ...recorded }),
            ],
          }),
        );
        givenStripe(ownIntent("pi_paid", TX_1, { status: "succeeded" }));

        const result = await execute(event({ amount: 100, existingPaymentIntentId: "pi_paid" }));

        expect(createMock()).toHaveBeenCalledOnce();
        expect(createMock().mock.calls[0][0].stripeMoney.amount).toBe(100_00);
        expect(cancelledIds()).toStrictEqual([]);
        expect(result._unsafeUnwrap()).toBeInstanceOf(
          TransactionInitializeSessionUseCaseResponses.Success,
        );
      });

      it("finds the record through the PaymentIntent's saleor_transaction_id too", async () => {
        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              checkoutTransaction({
                id: TX_1,
                pspReference: "",
                refundedAmount: usd(100),
                events: [{ type: "CHARGE_SUCCESS" }, { type: "REFUND_SUCCESS" }],
              }),
            ],
          }),
        );
        givenStripe(ownIntent("pi_paid", TX_1, { status: "succeeded" }));

        const result = await execute(event({ amount: 100, existingPaymentIntentId: "pi_paid" }));

        expect(createMock()).toHaveBeenCalledOnce();
        expect(result._unsafeUnwrap()).toBeInstanceOf(
          TransactionInitializeSessionUseCaseResponses.Success,
        );
      });

      it("still refuses while a paid PaymentIntent has only a failed or informational record", async () => {
        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              checkoutTransaction({
                id: TX_1,
                pspReference: "pi_paid",
                events: [
                  { type: "CHARGE_REQUEST" },
                  { type: "CHARGE_ACTION_REQUIRED" },
                  { type: "CHARGE_FAILURE" },
                  { type: "INFO" },
                ],
              }),
            ],
          }),
        );
        givenStripe(ownIntent("pi_paid", TX_1, { status: "succeeded" }));

        const result = await execute(event({ amount: 100, existingPaymentIntentId: "pi_paid" }));

        expect(failureError(result)).toBeInstanceOf(PaymentInFlightError);
        expect(createMock()).not.toHaveBeenCalled();
      });
    });

    /*
     * Review round 2 (MEDIUM): the NothingDue and PaymentPending refusals returned before any
     * Stripe call, so a PaymentIntent another tab still held stayed payable on a checkout
     * that was already paid (or about to be).
     */
    describe("refuses once nothing is left to pay or a payment is pending, after closing the payable PaymentIntents", () => {
      it.each([
        { case: "a pending charge", pending: { chargePendingAmount: usd(20) } },
        { case: "a pending authorization", pending: { authorizePendingAmount: usd(20) } },
      ])("when another transaction has $case", async ({ pending }) => {
        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              checkoutTransaction({ id: TX_1, pspReference: "pi_open" }),
              checkoutTransaction({ id: TX_2, pspReference: "pi_processing", ...pending }),
            ],
          }),
        );
        givenStripe(
          ownIntent("pi_open", TX_1),
          ownIntent("pi_processing", TX_2, { status: "processing" }),
        );

        const result = await execute(
          event({ amount: 100, existingPaymentIntentId: "pi_existing" }),
        );

        expect(failureError(result)).toBeInstanceOf(PaymentPendingError);
        expectChargeFailure(result);
        // The pending payment is recorded in Saleor: left alone. The open one is closed.
        expect(cancelledIds()).toStrictEqual(["pi_open"]);
        expect(createMock()).not.toHaveBeenCalled();
        expect(updateMock()).not.toHaveBeenCalled();
        expect(searchMock()).not.toHaveBeenCalled();
      });

      it.each([100, 120])(
        "when other transactions already hold %s of a 100 checkout",
        async (held) => {
          givenCheckout(
            checkoutState({
              transactions: [
                checkoutTransaction({ id: mockedSaleorTransactionId }),
                checkoutTransaction({ id: TX_1, pspReference: "pi_open" }),
                checkoutTransaction({
                  id: TX_2,
                  pspReference: "pi_paid",
                  chargedAmount: usd(held),
                  events: [{ type: "CHARGE_SUCCESS" }],
                }),
              ],
            }),
          );
          givenStripe(
            ownIntent("pi_open", TX_1, { status: "requires_action" }),
            ownIntent("pi_paid", TX_2, { status: "succeeded" }),
          );

          const result = await execute(event({ amount: 100 }));

          expect(failureError(result)).toBeInstanceOf(NothingDueError);
          expectChargeFailure(result);
          expect(cancelledIds()).toStrictEqual(["pi_open"]);
          expect(createMock()).not.toHaveBeenCalled();
          expect(updateMock()).not.toHaveBeenCalled();
        },
      );

      it("refuses without calling Stripe when the checkout lists no PaymentIntent", async () => {
        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              checkoutTransaction({
                id: TX_2,
                pspReference: "virement-1042",
                chargedAmount: usd(100),
              }),
            ],
          }),
        );

        const result = await execute(event({ amount: 100 }));

        expect(failureError(result)).toBeInstanceOf(NothingDueError);
        expectNoStripeCall();
      });
    });

    /*
     * Review round 2 (Q4): the exact-amount PaymentIntent came from Stripe's search index,
     * which lags by up to a minute. It is read again before it is handed out, and the
     * response is built from that live object.
     */
    describe("a PaymentIntent found by search is re-read before it is reused (Q4)", () => {
      const listedOnCheckout = () =>
        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              checkoutTransaction({ id: TX_1, pspReference: "pi_exact" }),
            ],
          }),
        );

      const indexed = ownIntent("pi_exact", TX_1);

      it("hands it out with the live status and amount", async () => {
        listedOnCheckout();
        givenStripe({ ...indexed, status: "requires_action" });
        searchMock().mockResolvedValue(ok([indexed]));

        const result = await execute(event({ amount: 100 }));

        expect(handedOut(result)).toBe("pi_exact");

        const response = result._unsafeUnwrap();

        expect(response.transactionResult.message).toBe("Payment intent requires action");
        expect(
          response instanceof TransactionInitializeSessionUseCaseResponses.Success &&
            response.saleorMoney.amount,
        ).toBe(100);
        expect(updateMock()).not.toHaveBeenCalled();
        expect(createMock()).not.toHaveBeenCalled();
      });

      it("updates it when its live amount is not the amount owed", async () => {
        listedOnCheckout();
        // e.g. /api/update-payment-intent changed it after the index was built.
        givenStripe({ ...indexed, amount: 50_00 });
        searchMock().mockResolvedValue(ok([indexed]));

        const result = await execute(event({ amount: 100 }));

        expect(handedOut(result)).toBe("pi_exact");
        expect(updateMock()).toHaveBeenCalledOnce();
        expect(updateMock().mock.calls[0][0].id).toBe("pi_exact");
        expect(updateMock().mock.calls[0][0].stripeMoney.amount).toBe(100_00);
        expect(createMock()).not.toHaveBeenCalled();
      });

      it("refuses when it is being paid and Saleor has not recorded it", async () => {
        listedOnCheckout();
        givenStripe({ ...indexed, status: "processing" });
        searchMock().mockResolvedValue(ok([indexed]));

        const result = await execute(event({ amount: 100 }));

        expect(failureError(result)).toBeInstanceOf(PaymentInFlightError);
        expect(updateMock()).not.toHaveBeenCalled();
        expect(createMock()).not.toHaveBeenCalled();
      });

      it("creates a new PaymentIntent when it was canceled since the index was built", async () => {
        listedOnCheckout();
        givenStripe({ ...indexed, status: "canceled" });
        searchMock().mockResolvedValue(ok([indexed]));

        const result = await execute(event({ amount: 100 }));

        expect(handedOut(result)).toBe("pi_created");
        expect(createMock()).toHaveBeenCalledOnce();
        expect(updateMock()).not.toHaveBeenCalled();
      });

      it("refuses when it cannot be read again", async () => {
        searchMock().mockResolvedValue(ok([indexed]));
        getMock().mockResolvedValue(err(new StripeAPIError("Stripe unavailable")));

        const result = await execute(event({ amount: 100 }));

        expect(failureError(result)).toBeInstanceOf(OtherPaymentsUnverifiedError);
        expect(createMock()).not.toHaveBeenCalled();
        expect(updateMock()).not.toHaveBeenCalled();
      });
    });

    describe("closing the other PaymentIntents (Q6)", () => {
      it("does not read a PaymentIntent whose Saleor transaction recorded its cancellation", async () => {
        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              checkoutTransaction({
                id: TX_1,
                pspReference: "pi_canceled",
                canceledAmount: usd(100),
                events: [{ type: "CANCEL_SUCCESS" }],
              }),
              checkoutTransaction({ id: TX_2, pspReference: "pi_open" }),
            ],
          }),
        );
        givenStripe(
          ownIntent("pi_canceled", TX_1, { status: "canceled" }),
          ownIntent("pi_open", TX_2),
        );

        const result = await execute(event({ amount: 100 }));

        expect(handedOut(result)).toBe("pi_created");
        expect(getMock().mock.calls.map(([args]) => args.id)).not.toContain("pi_canceled");
        expect(cancelledIds()).toStrictEqual(["pi_open"]);
      });

      it("reads at most 5 PaymentIntents from Stripe at a time", async () => {
        const ids = Array.from({ length: 12 }, (_, i) => `pi_tab_${i}`);

        givenCheckout(
          checkoutState({
            transactions: [
              checkoutTransaction({ id: mockedSaleorTransactionId }),
              ...ids.map((id, i) =>
                checkoutTransaction({ id: `VHJhbnNhY3Rpb25JdGVtOjEw${i}`, pspReference: id }),
              ),
            ],
          }),
        );
        givenStripe(...ids.map((id, i) => ownIntent(id, `VHJhbnNhY3Rpb25JdGVtOjEw${i}`)));

        let inFlight = 0;
        let maxInFlight = 0;

        const throttled =
          <A, R>(impl: (args: A) => Promise<R>) =>
          async (args: A): Promise<R> => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);

            try {
              await new Promise((resolve) => setTimeout(resolve, 1));

              return await impl(args);
            } finally {
              inFlight -= 1;
            }
          };

        const getImpl = getMock().getMockImplementation();
        const cancelImpl = cancelMock().getMockImplementation();

        if (!getImpl || !cancelImpl) {
          throw new Error("givenStripe must install the Stripe mocks");
        }

        getMock().mockImplementation(throttled(getImpl));
        cancelMock().mockImplementation(throttled(cancelImpl));

        const result = await execute(event({ amount: 100 }));

        expect(handedOut(result)).toBe("pi_created");
        expect([...cancelledIds()].sort()).toStrictEqual([...ids].sort());
        expect(maxInFlight).toBeGreaterThan(1);
        expect(maxInFlight).toBeLessThanOrEqual(5);
      });
    });

    describe("Order source (no storefront flow initializes on an order)", () => {
      it("still refuses when the Stripe search fails: no Saleor list covers an order's PaymentIntents", async () => {
        searchMock().mockResolvedValue(err(new StripeAPIError("search unavailable")));

        const result = await execute(event({ amount: 12.34, sourceType: "Order" }));

        expect(failureError(result)).toBeInstanceOf(OtherPaymentsUnverifiedError);
        expect(createMock()).not.toHaveBeenCalled();
      });

      it("keeps charging the requested amount and does not read a checkout", async () => {
        await execute(event({ amount: 12.34, sourceType: "Order" }));

        expect(mockCheckoutFetcher.fetchCheckoutPaymentState).not.toHaveBeenCalled();
        expect(createMock().mock.calls[0][0].stripeMoney.amount).toBe(12_34);
      });

      it("never updates a PaymentIntent created for another source", async () => {
        getMock().mockResolvedValue(
          ok(
            paymentIntent({
              id: "pi_foreign",
              metadata: { saleor_source_id: "T3JkZXI6OTk5", saleor_source_type: "Order" },
            }),
          ),
        );

        await execute(
          event({ amount: 12.34, sourceType: "Order", existingPaymentIntentId: "pi_foreign" }),
        );

        expect(updateMock()).not.toHaveBeenCalled();
        expect(createMock()).toHaveBeenCalledOnce();
      });
    });
  });
});
