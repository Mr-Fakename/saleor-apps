import { SaleorSyncWebhook } from "@saleor/app-sdk/handlers/next-app-router";

import {
  TransactionCancelationRequestedDocument,
  TransactionCancelationRequestedEventFragment,
} from "@/generated/graphql";
import { saleorApp } from "@/lib/saleor-app";

import { logRejectedSaleorWebhook } from "../log-rejected-webhook";

/**
 * Signature verification is the SDK default (`verifySignatureWithJwks`, JWKS refreshed
 * once on failure, 401 if it still fails). Never override `verifySignatureFn` (NR-28).
 */
export const transactionCancelationRequestedWebhookDefinition =
  new SaleorSyncWebhook<TransactionCancelationRequestedEventFragment>({
    apl: saleorApp.apl,
    event: "TRANSACTION_CANCELATION_REQUESTED",
    name: "Stripe Transaction Cancelation Requested",
    isActive: true,
    query: TransactionCancelationRequestedDocument,
    webhookPath: "api/webhooks/saleor/transaction-cancelation-requested",
    onError: logRejectedSaleorWebhook("TRANSACTION_CANCELATION_REQUESTED"),
  });
