import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createUserId } from "../domain/types";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

export class GetUserWishlistsTrpcHandler {
  baseProcedure = protectedClientProcedure;

  getTrpcProcedure() {
    return this.baseProcedure
      .input(z.void())
      .query(async ({ ctx }) => {
        // Get userId from authenticated context (JWT token)
        if (!ctx.userId) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "User ID not found in context",
          });
        }

        const wishlistsResult = await ctx.wishlistRepo!.getUserWishlists(
          {
            saleorApiUrl: ctx.saleorApiUrl!,
            appId: ctx.appId!,
          },
          createUserId(ctx.userId)
        );

        if (wishlistsResult.isErr()) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to fetch wishlists",
          });
        }

        return wishlistsResult.value.map((wishlist) => ({
          id: wishlist.id,
          name: wishlist.name,
          createdAt: wishlist.createdAt.toISOString(),
        }));
      });
  }
}
