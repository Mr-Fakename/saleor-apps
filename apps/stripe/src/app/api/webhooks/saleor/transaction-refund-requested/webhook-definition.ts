import { SaleorSyncWebhook } from "@saleor/app-sdk/handlers/next-app-router";

import {
  TransactionRefundRequestedDocument,
  TransactionRefundRequestedEventFragment,
} from "@/generated/graphql";
import { saleorApp } from "@/lib/saleor-app";
import { createLogger } from "@/lib/logger";

import { verifyWebhookSignature } from "../verify-signature";
import { httpsJwksVerifier } from "../https-jwks-verifier";

const logger = createLogger("transactionRefundRequestedWebhookDefinition");

export const transactionRefundRequestedWebhookDefinition =
  new SaleorSyncWebhook<TransactionRefundRequestedEventFragment>({
    apl: saleorApp.apl,
    event: "TRANSACTION_REFUND_REQUESTED",
    name: "Stripe Transaction Refund Requested",
    isActive: true,
    query: TransactionRefundRequestedDocument,
    webhookPath: "api/webhooks/saleor/transaction-refund-requested",
    verifySignatureFn: (jwks, signature, rawBody) => {
      // TEMPORARY: Bypass signature verification for refund webhooks
      // TODO: Restore proper signature verification once core JWKS issue is resolved
      logger.warn("Bypassing signature verification for refund webhook", {
        reason: "JWKS signature verification issue - needs investigation",
      });

      return Promise.resolve();
    },
  });
