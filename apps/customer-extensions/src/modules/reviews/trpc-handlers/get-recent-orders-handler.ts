import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { protectedDashboardProcedure } from "@/modules/trpc/protected-dashboard-procedure";

const logger = createLogger("GetRecentOrdersTrpcHandler");

const inputSchema = z.object({
  first: z.number().min(1).max(100).default(20),
  channel: z.string().optional(),
  search: z.string().optional(),
});

const outputSchema = z.object({
  orders: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      created: z.string(),
      status: z.string(),
      customerEmail: z.string().nullable(),
      customerName: z.string().nullable(),
    })
  ),
});

export class GetRecentOrdersTrpcHandler {
  getTrpcProcedure() {
    return protectedDashboardProcedure
      .input(inputSchema)
      .output(outputSchema)
      .query(async ({ ctx, input }) => {
        logger.debug("GetRecentOrders called", {
          saleorApiUrl: ctx.saleorApiUrl,
          first: input.first,
          channel: input.channel,
          search: input.search,
        });

        // Use search if provided, otherwise get recent orders
        const ordersResult = input.search
          ? await ctx.saleorClient.searchOrders({
              query: input.search,
              first: input.first,
            })
          : await ctx.saleorClient.getRecentOrders({
              first: input.first,
              channel: input.channel,
            });

        if (ordersResult.isErr()) {
          logger.error("Failed to fetch orders", {
            error: ordersResult.error,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to fetch orders",
          });
        }

        const ordersData = ordersResult.value;

        const orders = (ordersData?.edges || []).map((edge) => {
          const order = edge.node;
          const user = order.user;

          return {
            id: order.id,
            number: order.number,
            created: order.created,
            status: order.status,
            customerEmail: user?.email || null,
            customerName: user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() || null : null,
          };
        });

        logger.debug("Fetched orders", {
          count: orders.length,
        });

        return {
          orders,
        };
      });
  }
}
