import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { config } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import { createProductId, createUserId, createVariantId } from "@/modules/wishlists/domain/types";
import { SaleorClient } from "@/modules/saleor/saleor-client";
import { PurchaseVerifier } from "@/modules/reviews/services/purchase-verifier";
import { ReviewRepo } from "@/modules/reviews/repositories/review-repo";
import { ProductReview } from "@/modules/reviews/domain/product-review";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

const logger = createLogger("SubmitReviewTrpcHandler");

type Dependencies = {
  reviewRepo: ReviewRepo;
  saleorClient: SaleorClient;
  purchaseVerifier: PurchaseVerifier;
};

export class SubmitReviewTrpcHandler {
  baseProcedure = protectedClientProcedure;

  getTrpcProcedure() {
    return this.baseProcedure
      .input(
        z.object({
          productId: z.string(),
          variantId: z.string().optional(),
          rating: z.number().min(1).max(5),
          comment: z.string().min(10).max(1000),
        })
      )
      .mutation(async ({ input, ctx }) => {
        // Get userId from authenticated context (JWT token)
        if (!ctx.userId) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "User ID not found in context",
          });
        }

        logger.debug("Submitting review", {
          productId: input.productId,
          userId: ctx.userId,
          rating: input.rating,
        });

        // 1. Verify purchase
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
        if (!orderId) {
          logger.warn("User attempted to review product without purchase", {
            userId: ctx.userId,
            productId: input.productId,
          });
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You must purchase this product before reviewing it",
          });
        }

        // 2. Check if order is unlocked (if feature is enabled)
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
            logger.warn("User attempted to review product from unlocked order", {
              userId: ctx.userId,
              productId: input.productId,
              orderId,
            });
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "This order has not been unlocked for reviews yet",
            });
          }
        }

        // 3. Get user details
        const userResult = await ctx.saleorClient.getUser({
          userId: ctx.userId,
        });

        if (userResult.isErr()) {
          logger.error("Failed to fetch user details", {
            error: userResult.error,
            userId: ctx.userId,
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to fetch user details",
          });
        }

        const user = userResult.value;

        if (!user) {
          logger.error("User not found", { userId: ctx.userId });
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "User not found",
          });
        }

        // 4. Fetch product name for denormalization
        let productName: string | undefined;
        try {
          const productsResult = await ctx.saleorClient.getProductsByIds({
            productIds: [input.productId],
            channel: "default-channel",
          });

          if (productsResult.isOk() && productsResult.value?.edges?.[0]) {
            productName = productsResult.value.edges[0].node.name;
          }
        } catch (error) {
          logger.warn("Failed to fetch product name, continuing without it", {
            productId: input.productId,
            error,
          });
        }

        // 5. Create review domain entity
        const reviewResult = ProductReview.create({
          productId: createProductId(input.productId),
          userId: createUserId(ctx.userId),
          orderId,
          userEmail: user.email,
          userName: `${user.firstName || ""} ${user.lastName || ""}`.trim() || "Anonymous",
          rating: input.rating,
          comment: input.comment.trim(),
          productName,
        });

        if (reviewResult.isErr()) {
          logger.warn("Review validation failed", {
            error: reviewResult.error,
            userId: ctx.userId,
            productId: input.productId,
          });
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: reviewResult.error.message,
          });
        }

        // 6. Save to repository
        const saveResult = await ctx.reviewRepo.saveReview(
          {
            saleorApiUrl: ctx.saleorApiUrl!,
            appId: ctx.appId!,
          },
          reviewResult.value
        );

        if (saveResult.isErr()) {
          // Check if duplicate review
          if (saveResult.error._internalName === "ReviewRepoError.DuplicateReview") {
            logger.warn("Duplicate review attempted", {
              userId: ctx.userId,
              productId: input.productId,
            });
            throw new TRPCError({
              code: "CONFLICT",
              message: "You have already reviewed this product from this order",
            });
          }

          logger.error("Failed to save review", {
            error: saveResult.error,
            userId: ctx.userId,
            productId: input.productId,
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to save review",
          });
        }

        logger.info("Review submitted successfully", {
          reviewId: reviewResult.value.reviewId,
          userId: ctx.userId,
          productId: input.productId,
        });

        return {
          success: true,
          reviewId: reviewResult.value.reviewId,
        };
      });
  }
}
