import { SaleorSyncWebhook } from "@saleor/app-sdk/handlers/next-app-router";

import {
  TransactionChargeRequestedDocument,
  TransactionChargeRequestedEventFragment,
} from "@/generated/graphql";
import { saleorApp } from "@/lib/saleor-app";

import { logRejectedSaleorWebhook } from "../log-rejected-webhook";

/**
 * Signature verification is the SDK default (`verifySignatureWithJwks`, JWKS refreshed
 * once on failure, 401 if it still fails). Never override `verifySignatureFn` (NR-28).
 */
export const transactionChargeRequestedWebhookDefinition =
  new SaleorSyncWebhook<TransactionChargeRequestedEventFragment>({
    apl: saleorApp.apl,
    event: "TRANSACTION_CHARGE_REQUESTED",
    name: "Stripe Transaction Charge Requested",
    isActive: true,
    query: TransactionChargeRequestedDocument,
    webhookPath: "api/webhooks/saleor/transaction-charge-requested",
    onError: logRejectedSaleorWebhook("TRANSACTION_CHARGE_REQUESTED"),
  });
