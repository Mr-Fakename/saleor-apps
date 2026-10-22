import { TransactionRefundRequestedPayload } from "@/app/api/webhooks/saleor/transaction-refund-requested/refund-requested-payload";

import { mockedSaleorChannelId, mockedSaleorTransactionId } from "../constants";
import { mockedStripePaymentIntentId } from "../mocked-stripe-payment-intent-id";

/**
 * The payload of a Saleor whose webhook still has the subscription registered before reviews
 * M3 and round 2: no `grantedRefund`, no `transaction.events`. Tests add them when needed.
 */
export const getMockedTransactionRefundRequestedEvent = (): TransactionRefundRequestedPayload => ({
  action: {
    amount: 100,
    currency: "USD",
  },
  transaction: {
    id: mockedSaleorTransactionId,
    pspReference: mockedStripePaymentIntentId,
    checkout: {
      id: "mock-channel-1",
      channel: {
        id: mockedSaleorChannelId,
        slug: "channel-slug",
      },
    },
  },
});
