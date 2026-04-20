import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createWishlistId } from "../domain/types";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

export class GetWishlistItemsTrpcHandler {
  baseProcedure = protectedClientProcedure;

  getTrpcProcedure() {
    return this.baseProcedure
      .input(
        z.object({
          wishlistId: z.string(),
        })
      )
      .query(async ({ input, ctx }) => {
        const { wishlistId } = input;

        const itemsResult = await ctx.wishlistRepo!.getWishlistItems(
          {
            saleorApiUrl: ctx.saleorApiUrl!,
            appId: ctx.appId!,
          },
          createWishlistId(wishlistId)
        );

        if (itemsResult.isErr()) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to fetch wishlist items",
          });
        }

        return itemsResult.value.map((item) => ({
          productId: item.productId,
          variantId: item.variantId,
          productSlug: item.productSlug,
          productName: item.productName,
          addedAt: item.addedAt.toISOString(),
        }));
      });
  }
}
