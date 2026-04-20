import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { createProductId } from "@/modules/wishlists/domain/types";
import { ReviewRepo } from "@/modules/reviews/repositories/review-repo";
import { publicClientProcedure } from "@/modules/trpc/public-client-procedure";

const logger = createLogger("GetProductReviewsTrpcHandler");

export class GetProductReviewsTrpcHandler {
  baseProcedure = publicClientProcedure;

  getTrpcProcedure() {
    return this.baseProcedure
      .input(
        z.object({
          productId: z.string(),
        })
      )
      .query(async ({ input, ctx }) => {
        logger.debug("Fetching product reviews", {
          productId: input.productId,
        });

        const reviewsResult = await ctx.reviewRepo.getProductReviews(
          {
            saleorApiUrl: ctx.saleorApiUrl!,
            appId: ctx.appId!,
          },
          createProductId(input.productId)
        );

        if (reviewsResult.isErr()) {
          logger.error("Failed to fetch product reviews", {
            error: reviewsResult.error,
            productId: input.productId,
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to fetch product reviews",
          });
        }

        const reviews = reviewsResult.value;

        logger.debug("Product reviews fetched successfully", {
          productId: input.productId,
          count: reviews.length,
        });

        // Calculate average rating
        const averageRating =
          reviews.length > 0
            ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length
            : 0;

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
          averageRating,
          totalReviews: reviews.length,
        };
      });
  }
}
