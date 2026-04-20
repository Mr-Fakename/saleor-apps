import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { protectedDashboardProcedure } from "@/modules/trpc/protected-dashboard-procedure";
import { ReviewStatus } from "@/modules/reviews/domain/types";

const logger = createLogger("GetAllReviewsTrpcHandler");

const inputSchema = z
  .object({
    statusFilter: z.array(z.enum(["pending", "approved", "deleted"])).optional(),
  })
  .optional();

const outputSchema = z.object({
  reviews: z.array(
    z.object({
      reviewId: z.string(),
      productId: z.string(),
      userId: z.string(),
      orderId: z.string(),
      userEmail: z.string(),
      userName: z.string(),
      rating: z.number().min(1).max(5),
      comment: z.string(),
      verifiedPurchase: z.boolean(),
      createdAt: z.string(),
      modifiedAt: z.string(),
      status: z.enum(["pending", "approved", "deleted"]),
      deletedAt: z.string().nullable(),
      productName: z.string().nullable(),
    })
  ),
  totalReviews: z.number(),
});

export class GetAllReviewsTrpcHandler {
  getTrpcProcedure() {
    return protectedDashboardProcedure
      .input(inputSchema)
      .output(outputSchema)
      .query(async ({ ctx, input }) => {
        logger.debug("GetAllReviews called", {
          saleorApiUrl: ctx.saleorApiUrl,
          userId: ctx.userId,
          isStaff: ctx.isStaff,
          statusFilter: input?.statusFilter,
        });

        const access = {
          saleorApiUrl: ctx.saleorApiUrl,
          appId: ctx.appId,
        };

        // Build filter from input
        const filter = input?.statusFilter
          ? { status: input.statusFilter as ReviewStatus[] }
          : undefined;

        // Fetch all reviews with optional filter
        const reviewsResult = await ctx.reviewRepo.getAllReviews(access, filter);

        if (reviewsResult.isErr()) {
          logger.error("Failed to fetch all reviews", {
            error: reviewsResult.error,
          });
          throw new Error("Failed to fetch reviews");
        }

        const reviews = reviewsResult.value;

        logger.debug(`Returning ${reviews.length} reviews`);

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
            status: review.status,
            deletedAt: review.deletedAt?.toISOString() ?? null,
            productName: review.productName,
          })),
          totalReviews: reviews.length,
        };
      });
  }
}
