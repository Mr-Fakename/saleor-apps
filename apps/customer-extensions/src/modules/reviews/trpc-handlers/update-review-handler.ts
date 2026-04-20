import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { createProductId, createUserId } from "@/modules/wishlists/domain/types";
import { createOrderId, createReviewId } from "@/modules/reviews/domain/types";
import { ReviewRepo } from "@/modules/reviews/repositories/review-repo";
import { ProductReview } from "@/modules/reviews/domain/product-review";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

const logger = createLogger("UpdateReviewTrpcHandler");

export class UpdateReviewTrpcHandler {
  baseProcedure = protectedClientProcedure;

  getTrpcProcedure() {
    return this.baseProcedure
      .input(
        z.object({
          reviewId: z.string(),
          productId: z.string(),
          orderId: z.string(),
          rating: z.number().min(1).max(5).optional(),
          comment: z.string().min(10).max(1000).optional(),
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

        logger.debug("Updating review", {
          reviewId: input.reviewId,
          userId: ctx.userId,
          productId: input.productId,
        });

        // Validate that at least one field is being updated
        if (!input.rating && !input.comment) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "At least one field (rating or comment) must be provided for update",
          });
        }

        // First, get the existing review
        const existingReviewResult = await ctx.reviewRepo.getReviewById(
          {
            saleorApiUrl: ctx.saleorApiUrl!,
            appId: ctx.appId!,
          },
          createReviewId(input.reviewId),
          createProductId(input.productId)
        );

        if (existingReviewResult.isErr()) {
          logger.error("Failed to fetch existing review", {
            error: existingReviewResult.error,
            reviewId: input.reviewId,
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to fetch existing review",
          });
        }

        const existingReview = existingReviewResult.value;

        if (!existingReview) {
          logger.warn("Review not found", {
            reviewId: input.reviewId,
            productId: input.productId,
          });
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Review not found",
          });
        }

        // Verify ownership
        if (existingReview.userId !== ctx.userId) {
          logger.warn("User attempted to update another user's review", {
            reviewId: input.reviewId,
            userId: ctx.userId,
            reviewUserId: existingReview.userId,
          });
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You can only update your own reviews",
          });
        }

        // Create updated review with new values
        const updatedReviewResult = ProductReview.create({
          productId: createProductId(input.productId),
          userId: createUserId(ctx.userId),
          orderId: createOrderId(input.orderId),
          userEmail: existingReview.userEmail,
          userName: existingReview.userName,
          rating: input.rating !== undefined ? input.rating : existingReview.rating,
          comment: input.comment !== undefined ? input.comment.trim() : existingReview.comment,
        });

        if (updatedReviewResult.isErr()) {
          logger.warn("Updated review validation failed", {
            error: updatedReviewResult.error,
            reviewId: input.reviewId,
          });
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: updatedReviewResult.error.message,
          });
        }

        // Update the review (preserving reviewId and createdAt)
        const updatedReview = ProductReview.fromDatabase({
          reviewId: createReviewId(input.reviewId),
          productId: updatedReviewResult.value.productId,
          userId: updatedReviewResult.value.userId,
          orderId: updatedReviewResult.value.orderId,
          userEmail: updatedReviewResult.value.userEmail,
          userName: updatedReviewResult.value.userName,
          rating: updatedReviewResult.value.rating,
          comment: updatedReviewResult.value.comment,
          verifiedPurchase: updatedReviewResult.value.verifiedPurchase,
          createdAt: existingReview.createdAt,
          modifiedAt: new Date(),
        });

        const updateResult = await ctx.reviewRepo.updateReview(
          {
            saleorApiUrl: ctx.saleorApiUrl!,
            appId: ctx.appId!,
          },
          updatedReview
        );

        if (updateResult.isErr()) {
          logger.error("Failed to update review", {
            error: updateResult.error,
            reviewId: input.reviewId,
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to update review",
          });
        }

        logger.info("Review updated successfully", {
          reviewId: input.reviewId,
          userId: ctx.userId,
        });

        return {
          success: true,
          reviewId: input.reviewId,
        };
      });
  }
}
