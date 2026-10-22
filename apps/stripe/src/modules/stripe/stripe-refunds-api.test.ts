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
        { idempotencyKey: "IK" },
      );
    });
  });
});
