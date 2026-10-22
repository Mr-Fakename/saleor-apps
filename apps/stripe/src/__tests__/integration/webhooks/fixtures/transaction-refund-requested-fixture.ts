import {
  mockedSaleorAppId,
  mockedSaleorChannelId,
  mockedSaleorTransactionId,
} from "@/__tests__/mocks/constants";
import { TransactionRefundRequestedPayload } from "@/app/api/webhooks/saleor/transaction-refund-requested/refund-requested-payload";
import { StripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";

/** The payload of a Saleor still on the older subscription (no grantedRefund, no events). */
export const transactionRefundRequestedFixture = (
  stripePaymentIntentId: StripePaymentIntentId,
): TransactionRefundRequestedPayload => {
  return {
    recipient: {
      id: mockedSaleorAppId,
    },
    action: {
      amount: 123.3,
      currency: "USD",
    },
    transaction: {
      id: mockedSaleorTransactionId,
      pspReference: stripePaymentIntentId,
      checkout: {
        channel: {
          slug: "default-channel",
          id: mockedSaleorChannelId,
        },
        id: "checkout-id",
      },
    },
  };
};
