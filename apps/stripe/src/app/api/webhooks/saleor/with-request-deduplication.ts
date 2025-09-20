import { NextAppRouterSyncWebhookHandler } from "@saleor/app-sdk/handlers/next-app-router";
import { WebhookContext } from "@saleor/app-sdk/handlers/shared";
import { NextRequest } from "next/server";

import { createLogger } from "@/lib/logger";

const logger = createLogger("RequestDeduplication");

/*
 * In-memory cache for request deduplication (for demo purposes)
 * In production, you'd want to use Redis or similar distributed cache
 */
const requestCache = new Map<string, { timestamp: number; processing: boolean }>();

const CACHE_TTL = 60000; // 1 minute
const CLEANUP_INTERVAL = 300000; // 5 minutes

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();

  for (const [key, value] of requestCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      requestCache.delete(key);
    }
  }
}, CLEANUP_INTERVAL);

interface PayloadWithTransaction {
  sourceObject?: { id?: string };
  transaction?: { id?: string };
  action?: { amount?: number; actionType?: string };
}

export function withRequestDeduplication<Payload extends PayloadWithTransaction>(
  handler: NextAppRouterSyncWebhookHandler<Payload>,
) {
  return async (req: NextRequest, ctx: WebhookContext<Payload>) => {
    // Create a deduplication key based on checkout ID, transaction ID, and amount
    const sourceObjectId = ctx.payload.sourceObject?.id;
    const transactionId = ctx.payload.transaction?.id;
    const amount = ctx.payload.action?.amount;
    const actionType = ctx.payload.action?.actionType;

    if (!sourceObjectId || !transactionId) {
      // If we don't have enough info for deduplication, just proceed
      return handler(req, ctx);
    }

    const deduplicationKey = `${sourceObjectId}:${transactionId}:${amount}:${actionType}`;
    const now = Date.now();
    const existingRequest = requestCache.get(deduplicationKey);

    if (existingRequest) {
      if (existingRequest.processing) {
        logger.warn("Duplicate request detected while processing", {
          deduplicationKey: deduplicationKey,
          sourceObjectId: sourceObjectId,
          transactionId: transactionId,
        });

        // Return a 409 Conflict response for duplicate requests
        return Response.json({ message: "Request is already being processed" }, { status: 409 });
      } else if (now - existingRequest.timestamp < CACHE_TTL) {
        logger.warn("Duplicate request detected within TTL", {
          deduplicationKey: deduplicationKey,
          sourceObjectId: sourceObjectId,
          transactionId: transactionId,
          timeSinceLastRequest: now - existingRequest.timestamp,
        });

        // Return a 200 OK for recent successful requests
        return Response.json(
          { message: "Request already processed successfully" },
          { status: 200 },
        );
      }
    }

    // Mark request as processing
    requestCache.set(deduplicationKey, { timestamp: now, processing: true });

    try {
      const result = await handler(req, ctx);

      // Mark request as completed successfully
      requestCache.set(deduplicationKey, { timestamp: now, processing: false });

      return result;
    } catch (error) {
      // Remove from cache on error so it can be retried
      requestCache.delete(deduplicationKey);
      throw error;
    }
  };
}
