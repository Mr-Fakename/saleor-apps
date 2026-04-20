import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { protectedDashboardProcedure } from "@/modules/trpc/protected-dashboard-procedure";

const logger = createLogger("LockOrderTrpcHandler");

const inputSchema = z.object({
  orderId: z.string(),
});

const outputSchema = z.object({
  success: z.boolean(),
});

export class LockOrderTrpcHandler {
  getTrpcProcedure() {
    return protectedDashboardProcedure
      .input(inputSchema)
      .output(outputSchema)
      .mutation(async ({ ctx, input }) => {
        logger.debug("LockOrder called", {
          saleorApiUrl: ctx.saleorApiUrl,
          staffUserId: ctx.userId,
          orderId: input.orderId,
        });

        const access = {
          saleorApiUrl: ctx.saleorApiUrl,
          appId: ctx.appId,
        };

        const lockResult = await ctx.orderUnlockRepo.lockOrder(access, input.orderId);

        if (lockResult.isErr()) {
          logger.error("Failed to lock order", {
            error: lockResult.error,
            orderId: input.orderId,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to lock order",
          });
        }

        logger.info("Order locked successfully", {
          orderId: input.orderId,
          lockedBy: ctx.userId,
        });

        return {
          success: true,
        };
      });
  }
}
