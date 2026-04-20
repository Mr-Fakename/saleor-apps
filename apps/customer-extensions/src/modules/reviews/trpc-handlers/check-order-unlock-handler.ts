import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { protectedDashboardProcedure } from "@/modules/trpc/protected-dashboard-procedure";

const logger = createLogger("CheckOrderUnlockTrpcHandler");

const inputSchema = z.object({
  orderId: z.string(),
});

const outputSchema = z.object({
  isUnlocked: z.boolean(),
  unlock: z
    .object({
      orderId: z.string(),
      orderNumber: z.string(),
      customerEmail: z.string(),
      unlockedAt: z.string(),
      unlockedById: z.string(),
      unlockedByEmail: z.string(),
    })
    .nullable(),
});

export class CheckOrderUnlockTrpcHandler {
  getTrpcProcedure() {
    return protectedDashboardProcedure
      .input(inputSchema)
      .output(outputSchema)
      .query(async ({ ctx, input }) => {
        logger.debug("CheckOrderUnlock called", {
          saleorApiUrl: ctx.saleorApiUrl,
          orderId: input.orderId,
        });

        const access = {
          saleorApiUrl: ctx.saleorApiUrl,
          appId: ctx.appId,
        };

        const unlockResult = await ctx.orderUnlockRepo.getOrderUnlock(access, input.orderId);

        if (unlockResult.isErr()) {
          logger.error("Failed to check order unlock status", {
            error: unlockResult.error,
            orderId: input.orderId,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to check order unlock status",
          });
        }

        const unlock = unlockResult.value;

        if (!unlock) {
          return {
            isUnlocked: false,
            unlock: null,
          };
        }

        return {
          isUnlocked: true,
          unlock: {
            orderId: unlock.orderId,
            orderNumber: unlock.orderNumber,
            customerEmail: unlock.customerEmail,
            unlockedAt: unlock.unlockedAt.toISOString(),
            unlockedById: unlock.unlockedById,
            unlockedByEmail: unlock.unlockedByEmail,
          },
        };
      });
  }
}
