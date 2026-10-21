import { WebhookError } from "@saleor/app-sdk/handlers/shared";
import { SALEOR_API_URL_HEADER } from "@saleor/app-sdk/headers";

import { createLogger } from "@/lib/logger";

const logger = createLogger("SaleorWebhookRejected");

/**
 * `onError` for the Saleor webhook definitions. Logging only: the SDK still sends its own
 * error response (401 SIGNATURE_VERIFICATION_FAILED for a bad signature, 400 for a missing
 * one, 401 NOT_REGISTERED for an unknown saleor-api-url).
 */
export const logRejectedSaleorWebhook =
  (event: string) => (error: WebhookError | Error, request: Request) => {
    logger.warn(`${event} webhook rejected before reaching the handler`, {
      errorType: error instanceof WebhookError ? error.errorType : "UNEXPECTED",
      error: error.message,
      saleorApiUrl: request.headers.get(SALEOR_API_URL_HEADER),
    });
  };
