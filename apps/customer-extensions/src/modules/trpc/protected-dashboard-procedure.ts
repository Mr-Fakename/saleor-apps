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

const logger = createLogger("protectedDashboardProcedure");

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

const validateDashboardToken = middleware(async ({ ctx, next }) => {
  logger.debug("Calling validateDashboardToken middleware");

  if (!ctx.token) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing token in request. Dashboard access requires authentication.",
    });
  }

  if (!ctx.saleorApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Missing saleorApiUrl in request. This middleware can be used after auth is attached",
    });
  }

  setTag(ObservabilityAttributes.SALEOR_API_URL, ctx.saleorApiUrl);

  try {
    logger.debug("Verifying JWT token from dashboard", {
      token: ctx.token ? `${ctx.token.substring(0, 20)}...` : undefined,
      saleorApiUrl: ctx.saleorApiUrl,
    });

    // Verify dashboard token using JWKS
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

    // Check if user is staff
    if (!payload.is_staff) {
      logger.error("User is not staff, denying access", {
        userId: payload.user_id,
        email: payload.email,
      });

      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Dashboard access requires staff permissions",
      });
    }

    // Extract userId and email from the JWT payload and add it to context
    const userId = payload.user_id as string;
    const userEmail = payload.email as string | undefined;

    return next({
      ctx: {
        saleorApiUrl: ctx.saleorApiUrl,
        userId,
        userEmail,
        isStaff: true,
      },
    });
  } catch (error) {
    if (error instanceof TRPCError) {
      throw error;
    }

    logger.error("JWT verification failed with error", {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
      errorStack: error instanceof Error ? error.stack : undefined,
      saleorApiUrl: ctx.saleorApiUrl,
      hasToken: !!ctx.token,
    });

    throw new TRPCError({
      code: "UNAUTHORIZED",
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
 * Protected procedure for dashboard (staff) access
 * Validates that the user is staff and has appropriate permissions
 */
export const protectedDashboardProcedure = procedure
  .use(logErrors)
  .use(attachAppToken)
  .use(validateDashboardToken)
  .use(attachSharedServices);
