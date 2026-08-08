import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { protectedDashboardProcedure } from "@/modules/trpc/protected-dashboard-procedure";

const logger = createLogger("GetRecentOrdersTrpcHandler");

const inputSchema = z.object({
  // 100 is Saleor's hard per-page ceiling for this connection; the UI offers
  // 20/50/100 and pages with `after` rather than trying to fetch everything.
  first: z.number().min(1).max(100).default(20),
  after: z.string().optional(),
  channel: z.string().optional(),
  search: z.string().optional(),
});

const outputSchema = z.object({
  totalCount: z.number().nullable(),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    hasPreviousPage: z.boolean(),
    startCursor: z.string().nullable(),
    endCursor: z.string().nullable(),
  }),
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
          after: input.after,
          channel: input.channel,
          search: input.search,
        });

        // Use search if provided, otherwise get recent orders
        const ordersResult = input.search
          ? await ctx.saleorClient.searchOrders({
              query: input.search,
              first: input.first,
              after: input.after,
            })
          : await ctx.saleorClient.getRecentOrders({
              first: input.first,
              after: input.after,
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
          totalCount: ordersData?.totalCount ?? null,
          pageInfo: {
            hasNextPage: ordersData?.pageInfo?.hasNextPage ?? false,
            hasPreviousPage: ordersData?.pageInfo?.hasPreviousPage ?? false,
            startCursor: ordersData?.pageInfo?.startCursor ?? null,
            endCursor: ordersData?.pageInfo?.endCursor ?? null,
          },
          orders,
        };
      });
  }
}
