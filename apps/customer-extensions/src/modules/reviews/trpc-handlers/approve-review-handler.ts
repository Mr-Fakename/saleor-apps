import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { protectedDashboardProcedure } from "@/modules/trpc/protected-dashboard-procedure";
import { createProductId, createUserId } from "@/modules/wishlists/domain/types";

const logger = createLogger("ApproveReviewTrpcHandler");

const inputSchema = z.object({
  productId: z.string(),
  userId: z.string(),
  orderId: z.string(),
});

const outputSchema = z.object({
  success: z.boolean(),
});

export class ApproveReviewTrpcHandler {
  getTrpcProcedure() {
    return protectedDashboardProcedure
      .input(inputSchema)
      .output(outputSchema)
      .mutation(async ({ ctx, input }) => {
        logger.debug("ApproveReview called", {
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

        const approveResult = await ctx.reviewRepo.approveReview(
          access,
          createProductId(input.productId),
          createUserId(input.userId),
          input.orderId
        );

        if (approveResult.isErr()) {
          logger.error("Failed to approve review", {
            error: approveResult.error,
            productId: input.productId,
            userId: input.userId,
            orderId: input.orderId,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to approve review",
          });
        }

        logger.debug("Review approved successfully by admin", {
          productId: input.productId,
          userId: input.userId,
          orderId: input.orderId,
          approvedBy: ctx.userId,
        });

        return {
          success: true,
        };
      });
  }
}
