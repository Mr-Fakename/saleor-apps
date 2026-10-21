import { SaleorSyncWebhook } from "@saleor/app-sdk/handlers/next-app-router";

import {
  PaymentGatewayInitializeSessionDocument,
  PaymentGatewayInitializeSessionEventFragment,
} from "@/generated/graphql";
import { saleorApp } from "@/lib/saleor-app";

import { logRejectedSaleorWebhook } from "../log-rejected-webhook";

/**
 * Signature verification is the SDK default (`verifySignatureWithJwks`, JWKS refreshed
 * once on failure, 401 if it still fails). Never override `verifySignatureFn` (NR-28).
 */
export const paymentGatewayInitializeSessionWebhookDefinition =
  new SaleorSyncWebhook<PaymentGatewayInitializeSessionEventFragment>({
    apl: saleorApp.apl,
    event: "PAYMENT_GATEWAY_INITIALIZE_SESSION",
    name: "Stripe Payment Gateway Initialize",
    isActive: true,
    query: PaymentGatewayInitializeSessionDocument,
    webhookPath: "api/webhooks/saleor/payment-gateway-initialize-session",
    onError: logRejectedSaleorWebhook("PAYMENT_GATEWAY_INITIALIZE_SESSION"),
  });
