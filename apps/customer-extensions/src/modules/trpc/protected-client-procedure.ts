import { ObservabilityAttributes } from "@saleor/apps-otel/src/observability-attributes";
import { setTag } from "@sentry/nextjs";
import { TRPCError } from "@trpc/server";
import * as jose from "jose";

import { createLogger } from "@/lib/logger";
import { saleorApp } from "@/lib/saleor-app";
import { dynamodbWishlistRepo } from "@/modules/wishlists/repositories/dynamodb/dynamodb-wishlist-repo";
import { dynamodbReviewRepo } from "@/modules/reviews/repositories/dynamodb/dynamodb-review-repo";
import { dynamodbOrderUnlockRepo } from "@/modules/reviews/repositories/dynamodb/dynamodb-order-unlock-repo";
import { createSaleorClient } from "@/modules/saleor/saleor-client";
import { createPurchaseVerifier } from "@/modules/reviews/services/purchase-verifier";

import { getJWKS } from "./jwks-cache";
import { middleware, procedure } from "./trpc-server";

const logger = createLogger("protectedClientProcedure");

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
      orderUnlockRepo: dynamodbOrderUnlockRepo,
      saleorClient,
      purchaseVerifier,
    },
  });
});

const validateClientToken = middleware(async ({ ctx, next, meta }) => {
  logger.debug("Calling validateClientToken middleware with permissions required", {
    permissions: meta?.requiredClientPermissions,
  });

  if (!ctx.token) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Missing token in request. This middleware can be used only in frontend",
    });
  }

  // Note: We don't check for appId here because user tokens from storefront don't have an app property
  // appId is only needed for dashboard extensions, not for user authentication

  if (!ctx.saleorApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Missing saleorApiUrl in request. This middleware can be used after auth is attached",
    });
  }

  setTag(ObservabilityAttributes.SALEOR_API_URL, ctx.saleorApiUrl);

  try {
    logger.debug("trying to verify JWT token from frontend", {
      token: ctx.token ? `${ctx.token.substring(0, 20)}...` : undefined,
      saleorApiUrl: ctx.saleorApiUrl,
      requiredPermissions: meta?.requiredClientPermissions,
    });

    // Verify user token using JWKS (not app SDK's verifyJWT which is for dashboard extensions)
    // User tokens don't have an "app" property - they're standard Saleor user access tokens
    const saleorApiUrlWithoutGraphql = ctx.saleorApiUrl.replace(/\/graphql\/?$/, "");
    const jwksUrl = `${saleorApiUrlWithoutGraphql}/.well-known/jwks.json`;

    logger.debug("Fetching JWKS from", { jwksUrl });

    const JWKS = getJWKS(jwksUrl);
    const { payload } = await jose.jwtVerify(ctx.token, JWKS, {
      issuer: ctx.saleorApiUrl,
    });

    logger.debug("JWT verification successful", {
      userId: payload.user_id,
      email: payload.email,
      isStaff: payload.is_staff,
    });

    // Extract userId from the JWT payload and add it to context
    const userId = payload.user_id as string;

    return next({
      ctx: {
        saleorApiUrl: ctx.saleorApiUrl,
        userId,
      },
    });
  } catch (error) {
    logger.error("JWT verification failed with error", {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
      errorStack: error instanceof Error ? error.stack : undefined,
      saleorApiUrl: ctx.saleorApiUrl,
      hasToken: !!ctx.token,
    });
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "JWT verification failed",
    });
  }
});

const logErrors = middleware(async ({ next }) => {
  const result = await next();

  if (!result.ok) {
    logger.error(result.error.message, { error: result.error });
  }

  return result;
});

/**
 * Construct common services and attach them to the context
 *
 * Can be used only if called from the frontend (react-query),
 * otherwise jwks validation will fail (if createCaller used)
 */
export const protectedClientProcedure = procedure
  .use(logErrors)
  .use(attachAppToken)
  .use(validateClientToken)
  .use(attachSharedServices);
