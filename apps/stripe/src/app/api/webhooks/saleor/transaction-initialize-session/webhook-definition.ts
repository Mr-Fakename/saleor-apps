import { SaleorSyncWebhook } from "@saleor/app-sdk/handlers/next-app-router";

import {
  TransactionInitializeSessionDocument,
  TransactionInitializeSessionEventFragment,
} from "@/generated/graphql";
import { saleorApp } from "@/lib/saleor-app";

import { logRejectedSaleorWebhook } from "../log-rejected-webhook";

/**
 * Signature verification is the SDK default (`verifySignatureWithJwks`, JWKS refreshed
 * once on failure, 401 if it still fails). Never override `verifySignatureFn` (NR-28).
 */
export const transactionInitializeSessionWebhookDefinition =
  new SaleorSyncWebhook<TransactionInitializeSessionEventFragment>({
    apl: saleorApp.apl,
    event: "TRANSACTION_INITIALIZE_SESSION",
    name: "Stripe Transaction Initialize Session",
    isActive: true,
    query: TransactionInitializeSessionDocument,
    webhookPath: "api/webhooks/saleor/transaction-initialize-session",
    onError: logRejectedSaleorWebhook("TRANSACTION_INITIALIZE_SESSION"),
  });
