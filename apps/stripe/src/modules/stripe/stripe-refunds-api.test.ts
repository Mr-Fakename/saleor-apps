import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { mockedSaleorTransactionId } from "@/__tests__/mocks/constants";
import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { mockedStripeRestrictedKey } from "@/__tests__/mocks/mocked-stripe-restricted-key";
import { StripeClient } from "@/modules/stripe/stripe-client";
import { StripeMoney } from "@/modules/stripe/stripe-money";

import { StripeRefundsApi } from "./stripe-refunds-api";

describe("StripeRefundsApi", () => {
  describe("createRefund", () => {
    /*
     * A2e (c): Saleor 3.22.74 waits 2 s to connect + 18 s for the answer
     * (WEBHOOK_SYNC_TIMEOUT) and records a failure without retrying when the app is slower.
     * stripe-node's defaults (80 s per attempt, 2 retries) outlast that, so a slow Stripe is
     * cut short here: the app then answers HTTP 503 and Saleor re-sends the same request.
     *
     * Round 2 (P2): one attempt. stripe-node 18.1 waits up to 60 s for a Retry-After between
     * attempts (RequestSender._getSleepTimeInMS), and a second attempt that gets a definite
     * error (e.g. 429) after the first one created the refund was reported as REFUND_FAILURE.
     * stripe-node still retries once, 0.5 s later, when the connection was closed on the first
     * attempt (ECONNRESET/EPIPE, RequestSender._shouldRetry): worst case 2 x 6 s + 0.5 s.
     */
    it("makes one attempt of at most 6 s, so the app answers Saleor before its 18 s sync timeout", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);

      vi.spyOn(StripeClient, "createFromRestrictedKey").mockReturnValue(clientWrapper);
      vi.spyOn(clientWrapper.nativeClient.refunds, "create").mockResolvedValue({
        id: "re_test",
      } as Stripe.Response<Stripe.Refund>);

      await StripeRefundsApi.createFromKey({ key: mockedStripeRestrictedKey }).createRefund({
        paymentIntentId: mockedStripePaymentIntentId,
        stripeMoney: StripeMoney.createFromSaleorAmount({
          amount: 12.34,
          currency: "USD",
        })._unsafeUnwrap(),
        idempotencyKey: "IK",
      });

      // refunds.create is overloaded; the typed mock only shows the (options) overload.
      const [, options] = vi.mocked(clientWrapper.nativeClient.refunds.create).mock
        .calls[0] as unknown as [Stripe.RefundCreateParams, Stripe.RequestOptions | undefined];
      const timeout = options?.timeout ?? Infinity;

      expect(options?.maxNetworkRetries).toBe(0);
      // The forced connection-closed retry included: 2 attempts + 0.5 s back-off within 15 s.
      expect(2 * timeout + 500).toBeLessThanOrEqual(15_000);
      expect(options?.idempotencyKey).toBe("IK");
    });

    it("sends the idempotency key to Stripe as a request option (NR-32)", async () => {
      const clientWrapper = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);

      vi.spyOn(StripeClient, "createFromRestrictedKey").mockReturnValue(clientWrapper);
      vi.spyOn(clientWrapper.nativeClient.refunds, "create").mockResolvedValue({
        id: "re_test",
      } as Stripe.Response<Stripe.Refund>);

      const instance = StripeRefundsApi.createFromKey({ key: mockedStripeRestrictedKey });

      await instance.createRefund({
        paymentIntentId: mockedStripePaymentIntentId,
        stripeMoney: StripeMoney.createFromSaleorAmount({
          amount: 12.34,
          currency: "USD",
        })._unsafeUnwrap(),
        metadata: {
          saleor_source_id: "checkout-id",
          saleor_source_type: "Checkout",
          saleor_transaction_id: mockedSaleorTransactionId,
        },
        idempotencyKey: "IK",
      });

      expect(clientWrapper.nativeClient.refunds.create).toHaveBeenCalledExactlyOnceWith(
        {
          payment_intent: mockedStripePaymentIntentId,
          amount: 1234,
          metadata: {
            saleor_source_id: "checkout-id",
            saleor_source_type: "Checkout",
            saleor_transaction_id: mockedSaleorTransactionId,
          },
        },
        { idempotencyKey: "IK", timeout: 6_000, maxNetworkRetries: 0 },
      );
    });

    /*
     * Round 2 (P2), through the real stripe-node client (only fetch is mocked): the answer of
     * the single attempt goes back as is, so the use case can answer Saleor in time.
     */
    describe("stripe-node retry rules (real client, mocked fetch)", () => {
      const stripeAnswers = (status: number, error: object, headers: Record<string, string>) =>
        vi.spyOn(globalThis, "fetch").mockImplementation(
          async () =>
            new Response(JSON.stringify({ error }), {
              status,
              headers: { "content-type": "application/json", "request-id": "req_1", ...headers },
            }),
        );

      const createRefund = () =>
        StripeRefundsApi.createFromKey({ key: mockedStripeRestrictedKey }).createRefund({
          paymentIntentId: mockedStripePaymentIntentId,
          stripeMoney: StripeMoney.createFromSaleorAmount({
            amount: 12.34,
            currency: "USD",
          })._unsafeUnwrap(),
          idempotencyKey: "IK",
        });

      it("does not retry a Stripe 5xx that asks for a retry: the unknown outcome goes back to Saleor", async () => {
        const fetchSpy = stripeAnswers(
          500,
          { type: "api_error", message: "Something went wrong" },
          { "stripe-should-retry": "true" },
        );

        const result = await createRefund();

        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(result._unsafeUnwrapErr()).toBeInstanceOf(Stripe.errors.StripeAPIError);
      });

      it("does not wait for a Retry-After (stripe-node honours up to 60 s)", async () => {
        const fetchSpy = stripeAnswers(
          429,
          { type: "rate_limit_error", message: "Too many requests" },
          { "retry-after": "30", "stripe-should-retry": "true" },
        );
        const startedAt = Date.now();

        const result = await createRefund();

        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(result._unsafeUnwrapErr()).toBeInstanceOf(Stripe.errors.StripeRateLimitError);
      });
    });
  });
});
