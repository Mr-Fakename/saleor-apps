import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { protectedDashboardProcedure } from "@/modules/trpc/protected-dashboard-procedure";
import { createProductId, createUserId } from "@/modules/wishlists/domain/types";

const logger = createLogger("SoftDeleteReviewTrpcHandler");

const inputSchema = z.object({
  productId: z.string(),
  userId: z.string(),
  orderId: z.string(),
});

const outputSchema = z.object({
  success: z.boolean(),
});

export class SoftDeleteReviewTrpcHandler {
  getTrpcProcedure() {
    return protectedDashboardProcedure
      .input(inputSchema)
      .output(outputSchema)
      .mutation(async ({ ctx, input }) => {
        logger.debug("SoftDeleteReview called", {
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

        const softDeleteResult = await ctx.reviewRepo.softDeleteReview(
          access,
          createProductId(input.productId),
          createUserId(input.userId),
          input.orderId
        );

        if (softDeleteResult.isErr()) {
          logger.error("Failed to soft delete review", {
            error: softDeleteResult.error,
            productId: input.productId,
            userId: input.userId,
            orderId: input.orderId,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to soft delete review",
          });
        }

        logger.debug("Review soft deleted successfully by admin", {
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
