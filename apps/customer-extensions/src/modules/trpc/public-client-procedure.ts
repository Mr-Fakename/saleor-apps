import { ObservabilityAttributes } from "@saleor/apps-otel/src/observability-attributes";
import { setTag } from "@sentry/nextjs";
import { TRPCError } from "@trpc/server";

import { createLogger } from "@/lib/logger";
import { saleorApp } from "@/lib/saleor-app";
import { dynamodbWishlistRepo } from "@/modules/wishlists/repositories/dynamodb/dynamodb-wishlist-repo";
import { dynamodbReviewRepo } from "@/modules/reviews/repositories/dynamodb/dynamodb-review-repo";
import { createSaleorClient } from "@/modules/saleor/saleor-client";
import { createPurchaseVerifier } from "@/modules/reviews/services/purchase-verifier";

import { middleware, procedure } from "./trpc-server";

const logger = createLogger("publicClientProcedure");

const attachAppToken = middleware(async ({ ctx, next }) => {
  if (!ctx.saleorApiUrl) {
    logger.debug("ctx.saleorApiUrl not found, throwing");

    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Missing saleorApiUrl in request",
    });
  }

  logger.debug("Fetching auth data from APL", {
    saleorApiUrl: ctx.saleorApiUrl,
  });

  const authData = await saleorApp.apl.get(ctx.saleorApiUrl);

  if (!authData) {
    logger.error("authData not found in APL, throwing 401", {
      saleorApiUrl: ctx.saleorApiUrl,
      hint: "This means the app is not installed in Saleor or APL is empty. Please install/reinstall the app in Saleor.",
    });

    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing auth data",
    });
  }

  logger.debug("Auth data retrieved successfully", {
    appId: authData.appId,
    saleorApiUrl: authData.saleorApiUrl,
    hasToken: !!authData.token,
  });

  setTag(ObservabilityAttributes.SALEOR_API_URL, ctx.saleorApiUrl);

  return next({
    ctx: {
      appToken: authData.token,
      saleorApiUrl: authData.saleorApiUrl,
      appId: authData.appId,
    },
  });
});

const attachSharedServices = middleware(async ({ ctx, next }) => {
  // Create Saleor client with app token
  const saleorClient = createSaleorClient({
    saleorApiUrl: ctx.saleorApiUrl!,
    token: ctx.appToken,
  });

  // Create purchase verifier
  const purchaseVerifier = createPurchaseVerifier(saleorClient);

  return next({
    ctx: {
      wishlistRepo: dynamodbWishlistRepo,
      reviewRepo: dynamodbReviewRepo,
      saleorClient,
      purchaseVerifier,
    },
  });
});

const logErrors = middleware(async ({ next }) => {
  const result = await next();

  if (!result.ok) {
    logger.error(result.error.message, { error: result.error });
  }

  return result;
});

/**
 * Public client procedure for endpoints that don't require user authentication.
 * Use this for read-only operations like fetching product reviews.
 *
 * This procedure:
 * - Fetches app authentication from APL (for DynamoDB/Saleor API access)
 * - Attaches shared services (repositories, clients)
 * - Does NOT validate user JWT tokens (public access)
 */
export const publicClientProcedure = procedure
  .use(logErrors)
  .use(attachAppToken)
  .use(attachSharedServices);
