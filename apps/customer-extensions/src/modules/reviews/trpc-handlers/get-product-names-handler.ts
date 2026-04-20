import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createLogger } from "@/lib/logger";
import { protectedDashboardProcedure } from "@/modules/trpc/protected-dashboard-procedure";

const logger = createLogger("GetProductNamesTrpcHandler");

const inputSchema = z.object({
  productIds: z.array(z.string()),
});

const outputSchema = z.object({
  products: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    })
  ),
});

export class GetProductNamesTrpcHandler {
  getTrpcProcedure() {
    return protectedDashboardProcedure
      .input(inputSchema)
      .output(outputSchema)
      .query(async ({ ctx, input }) => {
        logger.debug("GetProductNames called", {
          saleorApiUrl: ctx.saleorApiUrl,
          productIdsCount: input.productIds.length,
        });

        if (input.productIds.length === 0) {
          return { products: [] };
        }

        // Remove duplicates
        const uniqueProductIds = [...new Set(input.productIds)];

        const productsResult = await ctx.saleorClient.getProductsByIds({
          productIds: uniqueProductIds,
          channel: "default-channel",
        });

        if (productsResult.isErr()) {
          logger.error("Failed to fetch product names", {
            error: productsResult.error,
            productIds: uniqueProductIds,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to fetch product names",
          });
        }

        const products = (productsResult.value?.edges || []).map((edge) => ({
          id: edge.node.id,
          name: edge.node.name,
        }));

        logger.debug(`Fetched ${products.length} product names`);

        return { products };
      });
  }
}
