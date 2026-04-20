import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { protectedDashboardProcedure } from "@/modules/trpc/protected-dashboard-procedure";
import { OrderUnlock } from "@/modules/reviews/domain/order-unlock";

const logger = createLogger("UnlockOrderTrpcHandler");

const inputSchema = z.object({
  orderId: z.string(),
  orderNumber: z.string(),
  customerEmail: z.string(),
});

const outputSchema = z.object({
  success: z.boolean(),
});

export class UnlockOrderTrpcHandler {
  getTrpcProcedure() {
    return protectedDashboardProcedure
      .input(inputSchema)
      .output(outputSchema)
      .mutation(async ({ ctx, input }) => {
        logger.debug("UnlockOrder called", {
          saleorApiUrl: ctx.saleorApiUrl,
          staffUserId: ctx.userId,
          orderId: input.orderId,
          orderNumber: input.orderNumber,
        });

        // Get staff email from JWT context (added by middleware)
        const staffEmail = ctx.userEmail || "staff@dashboard";

        // Create OrderUnlock domain entity
        const orderUnlockResult = OrderUnlock.create({
          orderId: input.orderId,
          orderNumber: input.orderNumber,
          customerEmail: input.customerEmail,
          unlockedById: ctx.userId,
          unlockedByEmail: staffEmail,
        });

        if (orderUnlockResult.isErr()) {
          logger.warn("OrderUnlock validation failed", {
            error: orderUnlockResult.error,
            orderId: input.orderId,
          });
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: orderUnlockResult.error.message,
          });
        }

        const access = {
          saleorApiUrl: ctx.saleorApiUrl,
          appId: ctx.appId,
        };

        const unlockResult = await ctx.orderUnlockRepo.unlockOrder(
          access,
          orderUnlockResult.value
        );

        if (unlockResult.isErr()) {
          logger.error("Failed to unlock order", {
            error: unlockResult.error,
            orderId: input.orderId,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to unlock order",
          });
        }

        logger.info("Order unlocked successfully", {
          orderId: input.orderId,
          orderNumber: input.orderNumber,
          unlockedBy: ctx.userId,
        });

        return {
          success: true,
        };
      });
  }
}
