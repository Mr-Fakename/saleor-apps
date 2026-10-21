import { SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next-app-router";
import { WebhookError } from "@saleor/app-sdk/handlers/shared";
import { SALEOR_API_URL_HEADER } from "@saleor/app-sdk/headers";

import { OrderFullyPaid, OrderFullyPaidDocument } from "@/generated/graphql";
import { createLogger } from "@/lib/logger";
import { saleorApp } from "@/lib/saleor-app";

const logger = createLogger("orderFullyPaidWebhookDefinition");

// Use the generated OrderFullyPaid type directly
export type OrderFullyPaidEventFragment = OrderFullyPaid;

/**
 * Signature verification is the SDK default (`verifySignatureWithJwks` from
 * `@saleor/app-sdk/auth`): the detached JWS in `saleor-signature` is checked against the JWKS
 * stored for the registered Saleor instance, refreshed once from that instance's
 * `/.well-known/jwks.json` on failure, and the webhook is rejected (401) if it still fails.
 *
 * Do NOT pass a custom `verifySignatureFn` that swallows errors: the handler trusts the payload
 * (order lines, buyer email) to mint download tokens, so a forged webhook means free downloads
 * emailed to any address (regression NR-03).
 */
export const orderFullyPaidWebhookDefinition = new SaleorAsyncWebhook<OrderFullyPaidEventFragment>({
  apl: saleorApp.apl,
  event: "ORDER_FULLY_PAID",
  name: "Digital Downloads Order Fully Paid v2",
  isActive: true,
  query: OrderFullyPaidDocument,
  webhookPath: "api/webhooks/saleor/order-fully-paid",
  onError(error, request) {
    // Logging only: the SDK still sends its own error response (401 for signature failures).
    logger.warn("ORDER_FULLY_PAID webhook rejected before reaching the handler", {
      errorType: error instanceof WebhookError ? error.errorType : "UNEXPECTED",
      error: error.message,
      saleorApiUrl: request.headers.get(SALEOR_API_URL_HEADER),
    });
  },
});
