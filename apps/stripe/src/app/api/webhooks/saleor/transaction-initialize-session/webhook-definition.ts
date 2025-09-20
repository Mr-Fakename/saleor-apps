import { SaleorSyncWebhook } from "@saleor/app-sdk/handlers/next-app-router";

import { verifyWebhookSignature } from "@/app/api/webhooks/saleor/verify-signature";
import {
  TransactionInitializeSessionDocument,
  TransactionInitializeSessionEventFragment,
} from "@/generated/graphql";
import { saleorApp } from "@/lib/saleor-app";

export const transactionInitializeSessionWebhookDefinition =
  new SaleorSyncWebhook<TransactionInitializeSessionEventFragment>({
    apl: saleorApp.apl,
    event: "TRANSACTION_INITIALIZE_SESSION",
    name: "Stripe Transaction Initialize Session",
    isActive: true,
    query: TransactionInitializeSessionDocument,
    webhookPath: "api/webhooks/saleor/transaction-initialize-session",
    verifySignatureFn: (jwks, signature, rawBody) => {
      console.log("=== WORKING WEBHOOK SIGNATURE DEBUG ===", {
        hasJwks: !!jwks,
        jwksType: typeof jwks,
        jwksLength: typeof jwks === "string" ? jwks.length : "N/A",
        jwksPreview:
          typeof jwks === "string" ? jwks.substring(0, 200) : String(jwks).substring(0, 200),
        hasSignature: !!signature,
        signatureLength: signature?.length,
        signaturePreview: signature?.substring(0, 100),
      });

      const promise = verifyWebhookSignature(jwks, signature, rawBody);

      promise
        .then(() => {
          console.log("=== WORKING WEBHOOK: Signature verification SUCCESS ===");
        })
        .catch((error) => {
          console.log("=== WORKING WEBHOOK: Signature verification FAILED ===", {
            error: error instanceof Error ? error.message : String(error),
          });
        });

      return promise;
    },
  });
