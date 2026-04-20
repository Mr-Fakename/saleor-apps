import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { protectedDashboardProcedure } from "@/modules/trpc/protected-dashboard-procedure";
import { createProductId, createUserId } from "@/modules/wishlists/domain/types";

const logger = createLogger("AdminDeleteReviewTrpcHandler");

const inputSchema = z.object({
  productId: z.string(),
  userId: z.string(),
  orderId: z.string(),
});

const outputSchema = z.object({
  success: z.boolean(),
});

export class AdminDeleteReviewTrpcHandler {
  getTrpcProcedure() {
    return protectedDashboardProcedure
      .input(inputSchema)
      .output(outputSchema)
      .mutation(async ({ ctx, input }) => {
        logger.debug("AdminDeleteReview called", {
          saleorApiUrl: ctx.saleorApiUrl,
          adminUserId: ctx.userId,
          reviewProductId: input.productId,
          reviewUserId: input.userId,
          orderId: input.orderId,
        });

        const access = {
          saleorApiUrl: ctx.saleorApiUrl,
          appId: ctx.appId,
        };

        // Admin can delete any review (no ownership check)
        const deleteResult = await ctx.reviewRepo.adminDeleteReview(
          access,
          createProductId(input.productId),
          createUserId(input.userId),
          input.orderId
        );

        if (deleteResult.isErr()) {
          logger.error("Failed to delete review", {
            error: deleteResult.error,
            productId: input.productId,
            userId: input.userId,
            orderId: input.orderId,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to delete review",
          });
        }

        logger.debug("Review deleted successfully by admin", {
          productId: input.productId,
          userId: input.userId,
          orderId: input.orderId,
          deletedBy: ctx.userId,
        });

        return {
          success: true,
        };
      });
  }
}
