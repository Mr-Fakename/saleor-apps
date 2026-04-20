import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { WishlistItem } from "../domain/wishlist-item";
import {
  createProductId,
  createProductSlug,
  createVariantId,
  createWishlistId,
} from "../domain/types";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

export class AddToWishlistTrpcHandler {
  baseProcedure = protectedClientProcedure;

  getTrpcProcedure() {
    return this.baseProcedure
      .input(
        z.object({
          wishlistId: z.string(),
          productId: z.string(),
          variantId: z.string(),
          productSlug: z.string(),
          productName: z.string(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { wishlistId, productId, variantId, productSlug, productName } = input;

        // Create domain entity
        const itemResult = WishlistItem.create({
          wishlistId: createWishlistId(wishlistId),
          productId: createProductId(productId),
          variantId: createVariantId(variantId),
          productSlug: createProductSlug(productSlug),
          productName,
        });

        if (itemResult.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: itemResult.error.message,
          });
        }

        // Save to repository
        const saveResult = await ctx.wishlistRepo!.addItemToWishlist(
          {
            saleorApiUrl: ctx.saleorApiUrl!,
            appId: ctx.appId!,
          },
          itemResult.value
        );

        if (saveResult.isErr()) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to add item to wishlist",
          });
        }

        return { success: true };
      });
  }
}
