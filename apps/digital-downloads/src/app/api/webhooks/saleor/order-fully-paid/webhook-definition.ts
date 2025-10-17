import { SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next-app-router";

import { verifySignatureFlexible } from "@/app/api/webhooks/saleor/verify-signature-flexible";
import {
  OrderFullyPaidDocument,
  OrderFullyPaidSubscription,
  OrderFullyPaid,
} from "@/generated/graphql";
import { saleorApp } from "@/lib/saleor-app";
import { createLogger } from "@/lib/logger";

const logger = createLogger("orderFullyPaidWebhookDefinition");

// Use the generated OrderFullyPaid type directly
export type OrderFullyPaidEventFragment = OrderFullyPaid;

export const orderFullyPaidWebhookDefinition = new SaleorAsyncWebhook<OrderFullyPaidEventFragment>({
  apl: saleorApp.apl,
  event: "ORDER_FULLY_PAID",
  name: "Digital Downloads Order Fully Paid v2",
  isActive: true,
  query: OrderFullyPaidDocument,
  webhookPath: "api/webhooks/saleor/order-fully-paid",
  verifySignatureFn: (jwks, signature, rawBody) => {
    logger.debug("ORDER_FULLY_PAID webhook signature verification started", {
      hasJwks: !!jwks,
      jwksLength: jwks?.length,
      hasSignature: !!signature,
      signatureLength: signature?.length,
      rawBodyLength: rawBody?.length,
    });

    // Use flexible verifier that handles HTTP/HTTPS URL differences in aud claim
    const promise = verifySignatureFlexible(jwks, signature, rawBody);

    promise
      .then(() => {
        logger.debug("ORDER_FULLY_PAID webhook signature verification succeeded");
      })
      .catch((error) => {
        logger.error("ORDER_FULLY_PAID webhook signature verification failed", {
          error: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        });
      });

    return promise;
  },
});
