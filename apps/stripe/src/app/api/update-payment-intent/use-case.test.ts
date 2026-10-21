import { APL } from "@saleor/app-sdk/APL";
import { err, ok } from "neverthrow";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockedSaleorChannelId } from "@/__tests__/mocks/constants";
import { mockAuthData } from "@/__tests__/mocks/mock-auth-data";
import { mockedStripePaymentIntentsApi } from "@/__tests__/mocks/mocked-stripe-payment-intents-api";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { AppConfigRepoError } from "@/modules/app-config/repositories/app-config-repo";
import {
  CheckoutPaymentState,
  CheckoutPaymentStateFetcherErrors,
  CheckoutPaymentStateTransaction,
  ICheckoutPaymentStateFetcher,
} from "@/modules/saleor/checkout-payment-state-fetcher";
import { IStripePaymentIntentsApiFactory } from "@/modules/stripe/types";

import {
  UpdatePaymentIntentAmountUseCase,
  UpdatePaymentIntentErrors,
  UpdatePaymentIntentRequest,
} from "./use-case";

const CHECKOUT_ID = "Q2hlY2tvdXQ6MQ==";
const TRANSACTION_ID = "VHJhbnNhY3Rpb25JdGVtOjE=";
const PAYMENT_INTENT_ID = "pi_3UseCaseTest";

const money = (amount: number, currency = "EUR") => ({ amount, currency });

const transaction = (
  overrides: Partial<CheckoutPaymentStateTransaction> = {},
): CheckoutPaymentStateTransaction => ({
  id: TRANSACTION_ID,
  pspReference: PAYMENT_INTENT_ID,
  chargedAmount: money(0),
  authorizedAmount: money(0),
  chargePendingAmount: money(0),
  authorizePendingAmount: money(0),
  ...overrides,
});

const checkoutState = (overrides: Partial<CheckoutPaymentState> = {}): CheckoutPaymentState => ({
  id: CHECKOUT_ID,
  channel: { id: mockedSaleorChannelId },
  totalPrice: { gross: money(103) },
  transactions: [transaction()],
  ...overrides,
});

const paymentIntent = (overrides: Partial<Stripe.PaymentIntent> = {}) =>
  ({
    id: PAYMENT_INTENT_ID,
    object: "payment_intent",
    amount: 100_00,
    currency: "eur",
    status: "requires_payment_method",
    client_secret: `${PAYMENT_INTENT_ID}_secret_test`,
    metadata: {
      saleor_source_id: CHECKOUT_ID,
      saleor_source_type: "Checkout",
      saleor_transaction_id: TRANSACTION_ID,
    },
    ...overrides,
  }) as Stripe.PaymentIntent;

const request = (overrides: Partial<UpdatePaymentIntentRequest> = {}): UpdatePaymentIntentRequest => ({
  paymentIntentId: PAYMENT_INTENT_ID,
  amount: 103,
  currency: "EUR",
  channelId: mockedSaleorChannelId,
  saleorApiUrl: mockedSaleorApiUrl,
  ...overrides,
});

const mockApl = {
  get: vi.fn(),
} satisfies Pick<APL, "get">;

const mockCheckoutFetcher = {
  fetchCheckoutPaymentState: vi.fn(),
} satisfies ICheckoutPaymentStateFetcher;

const stripePaymentIntentsApiFactory = {
  create: () => mockedStripePaymentIntentsApi,
} satisfies IStripePaymentIntentsApiFactory;

const createUseCase = () =>
  new UpdatePaymentIntentAmountUseCase({
    apl: mockApl,
    appConfigRepo: mockedAppConfigRepo,
    stripePaymentIntentsApiFactory,
    checkoutPaymentStateFetcherFactory: () => mockCheckoutFetcher,
  });

const updateMock = () => vi.mocked(mockedStripePaymentIntentsApi.updatePaymentIntent);

describe("UpdatePaymentIntentAmountUseCase", () => {
  beforeEach(() => {
    mockApl.get.mockResolvedValue(mockAuthData);
    vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent).mockResolvedValue(ok(paymentIntent()));
    updateMock().mockImplementation(async (args) =>
      ok(paymentIntent({ amount: args.stripeMoney.amount, currency: args.stripeMoney.currency })),
    );
    mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(ok(checkoutState()));
  });

  describe("amount rule", () => {
    it("writes the Saleor checkout total, ignoring a higher or lower requested amount", async () => {
      for (const requested of [1, 103, 5000]) {
        updateMock().mockClear();

        const result = await createUseCase().execute(request({ amount: requested }));

        expect(result._unsafeUnwrap()).toStrictEqual({
          paymentIntentId: PAYMENT_INTENT_ID,
          amount: 103_00,
          currency: "eur",
          updated: true,
        });
        expect(updateMock()).toHaveBeenCalledOnce();
        expect(updateMock().mock.calls[0][0].stripeMoney.amount).toBe(103_00);
      }
    });

    it("lowers the PaymentIntent when the fee line was removed from the checkout", async () => {
      vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent).mockResolvedValue(
        ok(paymentIntent({ amount: 103_00 })),
      );
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(
        ok(checkoutState({ totalPrice: { gross: money(100) } })),
      );

      const result = await createUseCase().execute(request({ amount: 100 }));

      expect(result._unsafeUnwrap().amount).toBe(100_00);
      expect(updateMock().mock.calls[0][0].stripeMoney.amount).toBe(100_00);
    });

    it("does not call Stripe when the PaymentIntent already holds the server amount", async () => {
      vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent).mockResolvedValue(
        ok(paymentIntent({ amount: 103_00 })),
      );

      const result = await createUseCase().execute(request({ amount: 1 }));

      expect(result._unsafeUnwrap()).toStrictEqual({
        paymentIntentId: PAYMENT_INTENT_ID,
        amount: 103_00,
        currency: "eur",
        updated: false,
      });
      expect(updateMock()).not.toHaveBeenCalled();
    });

    it("subtracts money already charged or authorized by OTHER transactions of the checkout", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(
        ok(
          checkoutState({
            transactions: [
              transaction(),
              transaction({
                id: "VHJhbnNhY3Rpb25JdGVtOjI=",
                pspReference: "pi_other",
                chargedAmount: money(40.1),
              }),
              transaction({
                id: "VHJhbnNhY3Rpb25JdGVtOjM=",
                pspReference: "",
                authorizedAmount: money(10.05),
              }),
            ],
          }),
        ),
      );

      const result = await createUseCase().execute(request());

      expect(result._unsafeUnwrap().amount).toBe(52_85);
      expect(updateMock().mock.calls[0][0].stripeMoney.amount).toBe(52_85);
    });

    it("treats a transaction linked by saleor_transaction_id (reused PaymentIntent) as its own", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(
        ok(checkoutState({ transactions: [transaction({ pspReference: "" })] })),
      );

      const result = await createUseCase().execute(request());

      expect(result._unsafeUnwrap().amount).toBe(103_00);
    });

    it("refuses (409) when another transaction still has pending money", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(
        ok(
          checkoutState({
            transactions: [
              transaction(),
              transaction({
                id: "VHJhbnNhY3Rpb25JdGVtOjI=",
                pspReference: "pi_other",
                chargePendingAmount: money(20),
              }),
            ],
          }),
        ),
      );

      const error = (await createUseCase().execute(request()))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.ConflictError);
      expect(error.httpStatus).toBe(409);
      expect(updateMock()).not.toHaveBeenCalled();
    });

    it("refuses (409) when other transactions already cover the whole checkout", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(
        ok(
          checkoutState({
            transactions: [
              transaction(),
              transaction({
                id: "VHJhbnNhY3Rpb25JdGVtOjI=",
                pspReference: "pi_other",
                chargedAmount: money(103),
              }),
            ],
          }),
        ),
      );

      const error = (await createUseCase().execute(request()))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.ConflictError);
      expect(updateMock()).not.toHaveBeenCalled();
    });
  });

  describe("ownership and state checks", () => {
    it.each(["processing", "requires_capture", "succeeded", "canceled"] as const)(
      "refuses (409) a PaymentIntent in status %s without calling Saleor or updating",
      async (status) => {
        vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent).mockResolvedValue(
          ok(paymentIntent({ status })),
        );

        const error = (await createUseCase().execute(request()))._unsafeUnwrapErr();

        expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.ConflictError);
        expect(mockCheckoutFetcher.fetchCheckoutPaymentState).not.toHaveBeenCalled();
        expect(updateMock()).not.toHaveBeenCalled();
      },
    );

    it.each(["requires_payment_method", "requires_confirmation", "requires_action"] as const)(
      "updates a PaymentIntent in status %s",
      async (status) => {
        vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent).mockResolvedValue(
          ok(paymentIntent({ status })),
        );

        expect((await createUseCase().execute(request())).isOk()).toBe(true);
        expect(updateMock()).toHaveBeenCalledOnce();
      },
    );

    it("refuses (403) a PaymentIntent created for an order, not a checkout", async () => {
      vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent).mockResolvedValue(
        ok(
          paymentIntent({
            metadata: { saleor_source_id: CHECKOUT_ID, saleor_source_type: "Order" },
          }),
        ),
      );

      const error = (await createUseCase().execute(request()))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.ForbiddenError);
      expect(error.httpStatus).toBe(403);
      expect(updateMock()).not.toHaveBeenCalled();
    });

    it("refuses (403) when the checkout is in another channel than the request names", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(
        ok(checkoutState({ channel: { id: "Q2hhbm5lbDoy" } })),
      );

      const error = (await createUseCase().execute(request()))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.ForbiddenError);
      expect(updateMock()).not.toHaveBeenCalled();
    });

    it("refuses (404) when Saleor no longer has the checkout (already completed)", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(ok(null));

      const error = (await createUseCase().execute(request()))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.NotFoundError);
      expect(error.publicMessage).toBe("Checkout not found");
      expect(updateMock()).not.toHaveBeenCalled();
    });

    it("refuses (502) when the Saleor query fails", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(
        err(new CheckoutPaymentStateFetcherErrors.FetchError("boom")),
      );

      const error = (await createUseCase().execute(request()))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.UpstreamError);
      expect(error.httpStatus).toBe(502);
      expect(updateMock()).not.toHaveBeenCalled();
    });

    it("refuses (404) a PaymentIntent that Stripe does not know for this account", async () => {
      vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent).mockResolvedValue(
        err(
          new Stripe.errors.StripeInvalidRequestError({
            message: "No such payment_intent",
            type: "invalid_request_error",
            code: "resource_missing",
          }),
        ),
      );

      const error = (await createUseCase().execute(request()))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.NotFoundError);
      expect(updateMock()).not.toHaveBeenCalled();
    });

    it("refuses (409) when the checkout currency differs from the PaymentIntent currency", async () => {
      mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(
        ok(checkoutState({ totalPrice: { gross: money(103, "USD") } })),
      );

      const error = (await createUseCase().execute(request()))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.ConflictError);
      expect(updateMock()).not.toHaveBeenCalled();
    });
  });

  describe("configuration", () => {
    it("returns 401 when the app is not installed", async () => {
      mockApl.get.mockResolvedValue(undefined);

      const error = (await createUseCase().execute(request()))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.AppNotInstalledError);
      expect(error.httpStatus).toBe(401);
      expect(mockedStripePaymentIntentsApi.getPaymentIntent).not.toHaveBeenCalled();
    });

    it("returns 400 for an invalid saleorApiUrl", async () => {
      const error = (
        await createUseCase().execute(request({ saleorApiUrl: "https://example.com/not-graphql" }))
      )._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.BadRequestError);
      expect(mockApl.get).not.toHaveBeenCalled();
    });

    it("returns 404 when the channel has no Stripe config", async () => {
      mockedAppConfigRepo.getStripeConfig.mockResolvedValue(ok(null));

      const error = (await createUseCase().execute(request()))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.NotFoundError);
      expect(error.publicMessage).toBe("Stripe not configured for this channel");
    });

    it("returns 500 when the config cannot be read", async () => {
      mockedAppConfigRepo.getStripeConfig.mockResolvedValue(
        err(new AppConfigRepoError.FailureFetchingConfig("dynamo down")),
      );

      const error = (await createUseCase().execute(request()))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.InternalError);
      expect(error.httpStatus).toBe(500);
    });

    it("returns 500 when Stripe refuses the update", async () => {
      updateMock().mockResolvedValue(err(new Error("stripe down")));

      const error = (await createUseCase().execute(request()))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.InternalError);
      expect(error.publicMessage).toBe("Failed to update payment intent");
    });
  });
});
