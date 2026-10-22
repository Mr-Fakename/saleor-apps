import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { mockedSaleorTransactionId } from "@/__tests__/mocks/constants";
import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { mockedStripeRestrictedKey } from "@/__tests__/mocks/mocked-stripe-restricted-key";
import { StripeClient } from "@/modules/stripe/stripe-client";
import { StripeMoney } from "@/modules/stripe/stripe-money";

import { StripePaymentIntentsApi } from "./stripe-payment-intents-api";

describe("StripePaymentIntentsApi", () => {
  describe("createPaymentIntent", () => {
    it("Calls inner Stripe SDK with expected params", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripePaymentIntentsApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.paymentIntents, "create").mockResolvedValue(
        // @ts-expect-error - in this test we dont care about the response
        {},
      );

      await instance.createPaymentIntent({
        idempotencyKey: "IK",
        stripeMoney: StripeMoney.createFromSaleorAmount({
          amount: 12.34,
          currency: "USD",
        })._unsafeUnwrap(),
        metadata: {
          saleor_source_id: "checkout-id",
          saleor_source_type: "Checkout",
          saleor_transaction_id: mockedSaleorTransactionId,
        },
        intentParams: {
          automatic_payment_methods: { enabled: true },
          payment_method_options: {
            klarna: {
              capture_method: "manual",
            },
          },
        },
      });

      expect(clientWrapper.nativeClient.paymentIntents.create).toHaveBeenCalledExactlyOnceWith(
        {
          amount: 1234,
          automatic_payment_methods: {
            enabled: true,
          },
          currency: "usd",
          metadata: {
            saleor_source_id: "checkout-id",
            saleor_source_type: "Checkout",
            saleor_transaction_id: mockedSaleorTransactionId,
          },
          payment_method_options: {
            klarna: {
              capture_method: "manual",
            },
          },
        },
        { idempotencyKey: "IK" },
      );
    });

    it("Calls inner Stripe SDK without metadata when not provided", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripePaymentIntentsApi.createFromClient(clientWrapper);

      vi.spyOn(clientWrapper.nativeClient.paymentIntents, "create").mockResolvedValue(
        // @ts-expect-error - in this test we dont care about the response
        {},
      );

      await instance.createPaymentIntent({
        idempotencyKey: "IK",
        stripeMoney: StripeMoney.createFromSaleorAmount({
          amount: 12.34,
          currency: "USD",
        })._unsafeUnwrap(),
        intentParams: {
          automatic_payment_methods: { enabled: true },
        },
      });

      expect(clientWrapper.nativeClient.paymentIntents.create).toHaveBeenCalledExactlyOnceWith(
        {
          amount: 1234,
          automatic_payment_methods: {
            enabled: true,
          },
          currency: "usd",
        },
        { idempotencyKey: "IK" },
      );
    });
  });

  describe("createFromKey", () => {
    it("creates instance of StripePaymentIntentsApi", () => {
      const api = StripePaymentIntentsApi.createFromKey({ key: mockedStripeRestrictedKey });

      expect(api).toBeInstanceOf(StripePaymentIntentsApi);
    });
  });

  /*
   * TRANSACTION_CHARGE_REQUESTED / TRANSACTION_CANCELATION_REQUESTED: Saleor 3.22.74 waits 2 s to
   * connect and 18 s for the answer (settings.WEBHOOK_SYNC_TIMEOUT) and records its own failure,
   * without a retry, when the app is slower. One handler call makes a live read and at most one
   * write. Each is a single attempt: an unknown outcome goes back to the use case, which answers
   * HTTP 503, and Saleor re-sends the request (handle_transaction_request_task). stripe-node
   * still retries once, 0.5 s later, when the connection was closed on the first attempt
   * (RequestSender._shouldRetry), even with maxNetworkRetries 0.
   */
  describe("calls made while Saleor waits for a transaction action answer", () => {
    const optionsOfCall = (mock: unknown) =>
      (vi.mocked(mock as (...args: unknown[]) => unknown).mock.calls[0] as unknown[])[2] as
        | Stripe.RequestOptions
        | undefined;

    const setUp = () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
      const instance = StripePaymentIntentsApi.createFromClient(clientWrapper);
      const paymentIntent = {
        id: mockedStripePaymentIntentId,
      } as unknown as Stripe.Response<Stripe.PaymentIntent>;

      vi.spyOn(clientWrapper.nativeClient.paymentIntents, "retrieve").mockResolvedValue(
        paymentIntent,
      );
      vi.spyOn(clientWrapper.nativeClient.paymentIntents, "capture").mockResolvedValue(
        paymentIntent,
      );
      vi.spyOn(clientWrapper.nativeClient.paymentIntents, "cancel").mockResolvedValue(
        paymentIntent,
      );

      return { instance, paymentIntents: clientWrapper.nativeClient.paymentIntents };
    };

    it("captures exactly the given amount with the idempotency key, in one bounded attempt", async () => {
      const { instance, paymentIntents } = setUp();

      await instance.capturePaymentIntent({
        id: mockedStripePaymentIntentId,
        amountToCapture: 60_00,
        idempotencyKey: "capture:v1:pi_TEST_TEST_TEST:6000",
      });

      expect(paymentIntents.capture).toHaveBeenCalledExactlyOnceWith(
        mockedStripePaymentIntentId,
        { amount_to_capture: 60_00 },
        expect.objectContaining({
          idempotencyKey: "capture:v1:pi_TEST_TEST_TEST:6000",
          maxNetworkRetries: 0,
        }),
      );
      expect(optionsOfCall(paymentIntents.capture)?.timeout).toBeGreaterThan(0);
    });

    it("cancels with the idempotency key, in one bounded attempt", async () => {
      const { instance, paymentIntents } = setUp();

      await instance.cancelPaymentIntentForTransactionAction({
        id: mockedStripePaymentIntentId,
        idempotencyKey: "cancel:v1:pi_TEST_TEST_TEST",
      });

      expect(paymentIntents.cancel).toHaveBeenCalledExactlyOnceWith(
        mockedStripePaymentIntentId,
        {},
        expect.objectContaining({
          idempotencyKey: "cancel:v1:pi_TEST_TEST_TEST",
          maxNetworkRetries: 0,
        }),
      );
      expect(optionsOfCall(paymentIntents.cancel)?.timeout).toBeGreaterThan(0);
    });

    it("reads the live PaymentIntent in one bounded attempt", async () => {
      const { instance, paymentIntents } = setUp();

      await instance.getPaymentIntentForTransactionAction({ id: mockedStripePaymentIntentId });

      expect(paymentIntents.retrieve).toHaveBeenCalledExactlyOnceWith(
        mockedStripePaymentIntentId,
        {},
        expect.objectContaining({ maxNetworkRetries: 0 }),
      );
      expect(optionsOfCall(paymentIntents.retrieve)?.timeout).toBeGreaterThan(0);
    });

    it("answers Saleor within its 18 s sync timeout: read + write, each with the forced connection-closed retry, fit in 16 s", async () => {
      const { instance, paymentIntents } = setUp();

      await instance.getPaymentIntentForTransactionAction({ id: mockedStripePaymentIntentId });
      await instance.capturePaymentIntent({
        id: mockedStripePaymentIntentId,
        amountToCapture: 1,
        idempotencyKey: "IK",
      });
      await instance.cancelPaymentIntentForTransactionAction({
        id: mockedStripePaymentIntentId,
        idempotencyKey: "IK",
      });

      const readTimeout = optionsOfCall(paymentIntents.retrieve)?.timeout ?? Infinity;
      const captureTimeout = optionsOfCall(paymentIntents.capture)?.timeout ?? Infinity;
      const cancelTimeout = optionsOfCall(paymentIntents.cancel)?.timeout ?? Infinity;
      const worstCase = (timeout: number) => 2 * timeout + 500;

      expect(worstCase(readTimeout) + worstCase(captureTimeout)).toBeLessThanOrEqual(16_000);
      expect(worstCase(readTimeout) + worstCase(cancelTimeout)).toBeLessThanOrEqual(16_000);
    });
  });
});
