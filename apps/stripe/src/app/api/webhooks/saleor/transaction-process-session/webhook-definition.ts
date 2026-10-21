import { SaleorSyncWebhook } from "@saleor/app-sdk/handlers/next-app-router";

import {
  TransactionProcessSessionDocument,
  TransactionProcessSessionEventFragment,
} from "@/generated/graphql";
import { saleorApp } from "@/lib/saleor-app";

import { logRejectedSaleorWebhook } from "../log-rejected-webhook";

/**
 * Signature verification is the SDK default (`verifySignatureWithJwks`, JWKS refreshed
 * once on failure, 401 if it still fails). Never override `verifySignatureFn` (NR-28).
 */
export const transactionProcessSessionWebhookDefinition =
  new SaleorSyncWebhook<TransactionProcessSessionEventFragment>({
    apl: saleorApp.apl,
    event: "TRANSACTION_PROCESS_SESSION",
    name: "Stripe Transaction Process Session",
    isActive: true,
    query: TransactionProcessSessionDocument,
    webhookPath: "api/webhooks/saleor/transaction-process-session",
    onError: logRejectedSaleorWebhook("TRANSACTION_PROCESS_SESSION"),
  });
