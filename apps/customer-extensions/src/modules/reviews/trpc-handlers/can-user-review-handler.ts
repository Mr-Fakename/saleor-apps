import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { config } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import { createProductId, createUserId, createVariantId } from "@/modules/wishlists/domain/types";
import { ReviewRepo } from "@/modules/reviews/repositories/review-repo";
import { PurchaseVerifier } from "@/modules/reviews/services/purchase-verifier";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

const logger = createLogger("CanUserReviewTrpcHandler");

export class CanUserReviewTrpcHandler {
  baseProcedure = protectedClientProcedure;

  getTrpcProcedure() {
    return this.baseProcedure
      .input(
        z.object({
          productId: z.string(),
          variantId: z.string().optional(),
        })
      )
      .query(async ({ input, ctx }) => {
        // Get userId from authenticated context (JWT token)
        if (!ctx.userId) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "User ID not found in context",
          });
        }

        logger.debug("Checking if user can review product", {
          productId: input.productId,
          userId: ctx.userId,
        });

        // 1. Check if user has purchased the product
        const verificationResult = await ctx.purchaseVerifier.verifyProductPurchase({
          userId: createUserId(ctx.userId),
          productId: createProductId(input.productId),
          variantId: input.variantId ? createVariantId(input.variantId) : undefined,
        });

        if (verificationResult.isErr()) {
          logger.error("Failed to verify purchase", {
            error: verificationResult.error,
            userId: ctx.userId,
            productId: input.productId,
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to verify purchase",
          });
        }

        const orderId = verificationResult.value;
        const hasPurchased = orderId !== null;

        if (!hasPurchased) {
          logger.debug("User has not purchased product", {
            userId: ctx.userId,
            productId: input.productId,
          });
          return {
            canReview: false,
            reason: "NOT_PURCHASED",
            message: "You must purchase this product before reviewing it",
          };
        }

        // 2. Check if user has already reviewed this product
        const hasReviewedResult = await ctx.reviewRepo.hasUserReviewedProduct(
          {
            saleorApiUrl: ctx.saleorApiUrl!,
            appId: ctx.appId!,
          },
          createUserId(ctx.userId),
          createProductId(input.productId)
        );

        if (hasReviewedResult.isErr()) {
          logger.error("Failed to check if user has reviewed product", {
            error: hasReviewedResult.error,
            userId: ctx.userId,
            productId: input.productId,
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to check review status",
          });
        }

        const hasReviewed = hasReviewedResult.value;

        if (hasReviewed) {
          logger.debug("User has already reviewed product", {
            userId: ctx.userId,
            productId: input.productId,
          });
          return {
            canReview: false,
            reason: "ALREADY_REVIEWED",
            message: "You have already reviewed this product",
          };
        }

        // 3. Check if order is unlocked (if feature is enabled)
        if (config.requireOrderUnlockForReviews) {
          const isUnlockedResult = await ctx.orderUnlockRepo.isOrderUnlocked(
            {
              saleorApiUrl: ctx.saleorApiUrl!,
              appId: ctx.appId!,
            },
            orderId
          );

          if (isUnlockedResult.isErr()) {
            logger.error("Failed to check order unlock status", {
              error: isUnlockedResult.error,
              userId: ctx.userId,
              productId: input.productId,
              orderId,
            });
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to check order unlock status",
            });
          }

          const isUnlocked = isUnlockedResult.value;

          if (!isUnlocked) {
            logger.debug("Order not unlocked for reviews", {
              userId: ctx.userId,
              productId: input.productId,
              orderId,
            });
            return {
              canReview: false,
              reason: "ORDER_NOT_UNLOCKED",
              message: "This order has not been unlocked for reviews yet. Please wait for order confirmation.",
            };
          }
        }

        logger.debug("User can review product", {
          userId: ctx.userId,
          productId: input.productId,
        });

        return {
          canReview: true,
          orderId,
          message: "You can review this product",
        };
      });
  }
}
