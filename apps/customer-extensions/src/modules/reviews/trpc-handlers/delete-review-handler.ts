import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { createProductId, createUserId } from "@/modules/wishlists/domain/types";
import { ReviewRepo } from "@/modules/reviews/repositories/review-repo";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

const logger = createLogger("DeleteReviewTrpcHandler");

export class DeleteReviewTrpcHandler {
  baseProcedure = protectedClientProcedure;

  getTrpcProcedure() {
    return this.baseProcedure
      .input(
        z.object({
          productId: z.string(),
          orderId: z.string(),
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

        logger.debug("Deleting review", {
          productId: input.productId,
          userId: ctx.userId,
          orderId: input.orderId,
        });

        const deleteResult = await ctx.reviewRepo.deleteReview(
          {
            saleorApiUrl: ctx.saleorApiUrl!,
            appId: ctx.appId!,
          },
          createProductId(input.productId),
          createUserId(ctx.userId),
          input.orderId
        );

        if (deleteResult.isErr()) {
          logger.error("Failed to delete review", {
            error: deleteResult.error,
            productId: input.productId,
            userId: ctx.userId,
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to delete review",
          });
        }

        logger.info("Review deleted successfully", {
          productId: input.productId,
          userId: ctx.userId,
        });

        return {
          success: true,
        };
      });
  }
}
