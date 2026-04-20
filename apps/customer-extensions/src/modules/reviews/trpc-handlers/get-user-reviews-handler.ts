import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { createUserId } from "@/modules/wishlists/domain/types";
import { ReviewRepo } from "@/modules/reviews/repositories/review-repo";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

const logger = createLogger("GetUserReviewsTrpcHandler");

export class GetUserReviewsTrpcHandler {
  baseProcedure = protectedClientProcedure;

  getTrpcProcedure() {
    return this.baseProcedure
      .input(z.void())
      .query(async ({ ctx }) => {
        // Get userId from authenticated context (JWT token)
        if (!ctx.userId) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "User ID not found in context",
          });
        }

        logger.debug("Fetching user reviews", {
          userId: ctx.userId,
        });

        const reviewsResult = await ctx.reviewRepo.getUserReviews(
          {
            saleorApiUrl: ctx.saleorApiUrl!,
            appId: ctx.appId!,
          },
          createUserId(ctx.userId)
        );

        if (reviewsResult.isErr()) {
          logger.error("Failed to fetch user reviews", {
            error: reviewsResult.error,
            userId: ctx.userId,
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to fetch user reviews",
          });
        }

        const reviews = reviewsResult.value;

        logger.debug("User reviews fetched successfully", {
          userId: ctx.userId,
          count: reviews.length,
        });

        return {
          reviews: reviews.map((review) => ({
            reviewId: review.reviewId,
            productId: review.productId,
            userId: review.userId,
            orderId: review.orderId,
            userEmail: review.userEmail,
            userName: review.userName,
            rating: review.rating,
            comment: review.comment,
            verifiedPurchase: review.verifiedPurchase,
            createdAt: review.createdAt.toISOString(),
            modifiedAt: review.modifiedAt.toISOString(),
          })),
          totalReviews: reviews.length,
        };
      });
  }
}
