import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { protectedDashboardProcedure } from "@/modules/trpc/protected-dashboard-procedure";

const logger = createLogger("GetUnlockedOrdersTrpcHandler");

const outputSchema = z.object({
  unlockedOrders: z.array(
    z.object({
      orderId: z.string(),
      orderNumber: z.string(),
      customerEmail: z.string(),
      unlockedAt: z.string(),
      unlockedById: z.string(),
      unlockedByEmail: z.string(),
    })
  ),
});

export class GetUnlockedOrdersTrpcHandler {
  getTrpcProcedure() {
    return protectedDashboardProcedure.output(outputSchema).query(async ({ ctx }) => {
      logger.debug("GetUnlockedOrders called", {
        saleorApiUrl: ctx.saleorApiUrl,
        staffUserId: ctx.userId,
      });

      const access = {
        saleorApiUrl: ctx.saleorApiUrl,
        appId: ctx.appId,
      };

      const unlockedOrdersResult = await ctx.orderUnlockRepo.getUnlockedOrders(access);

      if (unlockedOrdersResult.isErr()) {
        logger.error("Failed to fetch unlocked orders", {
          error: unlockedOrdersResult.error,
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to fetch unlocked orders",
        });
      }

      const unlockedOrders = unlockedOrdersResult.value.map((unlock) => ({
        orderId: unlock.orderId,
        orderNumber: unlock.orderNumber,
        customerEmail: unlock.customerEmail,
        unlockedAt: unlock.unlockedAt.toISOString(),
        unlockedById: unlock.unlockedById,
        unlockedByEmail: unlock.unlockedByEmail,
      }));

      logger.debug("Fetched unlocked orders", {
        count: unlockedOrders.length,
      });

      return {
        unlockedOrders,
      };
    });
  }
}
