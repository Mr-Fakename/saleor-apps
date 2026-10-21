import { SaleorSyncWebhook } from "@saleor/app-sdk/handlers/next-app-router";

import {
  TransactionRefundRequestedDocument,
  TransactionRefundRequestedEventFragment,
} from "@/generated/graphql";
import { saleorApp } from "@/lib/saleor-app";

import { logRejectedSaleorWebhook } from "../log-rejected-webhook";

/**
 * Signature verification is the SDK default (`verifySignatureWithJwks` from
 * `@saleor/app-sdk/auth`): the detached JWS in `saleor-signature` is checked against the
 * JWKS stored for the registered Saleor, refreshed once from that Saleor's
 * `/.well-known/jwks.json` on failure, and the webhook is rejected (401) if it still fails.
 *
 * Never pass a `verifySignatureFn` that skips or swallows verification: this handler
 * creates Stripe refunds from the payload, so a forged webhook refunds a real payment
 * (regression NR-28).
 */
export const transactionRefundRequestedWebhookDefinition =
  new SaleorSyncWebhook<TransactionRefundRequestedEventFragment>({
    apl: saleorApp.apl,
    event: "TRANSACTION_REFUND_REQUESTED",
    name: "Stripe Transaction Refund Requested",
    isActive: true,
    query: TransactionRefundRequestedDocument,
    webhookPath: "api/webhooks/saleor/transaction-refund-requested",
    onError: logRejectedSaleorWebhook("TRANSACTION_REFUND_REQUESTED"),
  });
