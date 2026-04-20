import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createProductId, createVariantId, createWishlistId } from "../domain/types";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

export class RemoveFromWishlistTrpcHandler {
  baseProcedure = protectedClientProcedure;

  getTrpcProcedure() {
    return this.baseProcedure
      .input(
        z.object({
          wishlistId: z.string(),
          productId: z.string(),
          variantId: z.string(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { wishlistId, productId, variantId } = input;

        const removeResult = await ctx.wishlistRepo!.removeItemFromWishlist(
          {
            saleorApiUrl: ctx.saleorApiUrl!,
            appId: ctx.appId!,
          },
          createWishlistId(wishlistId),
          createProductId(productId),
          createVariantId(variantId)
        );

        if (removeResult.isErr()) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to remove item from wishlist",
          });
        }

        return { success: true };
      });
  }
}
