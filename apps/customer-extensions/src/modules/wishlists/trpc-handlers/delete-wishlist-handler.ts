import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createUserId, createWishlistId } from "../domain/types";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

export class DeleteWishlistTrpcHandler {
  baseProcedure = protectedClientProcedure;

  getTrpcProcedure() {
    return this.baseProcedure
      .input(
        z.object({
          wishlistId: z.string(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { wishlistId } = input;

        // Get userId from authenticated context (JWT token)
        if (!ctx.userId) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "User ID not found in context",
          });
        }

        const deleteResult = await ctx.wishlistRepo!.deleteWishlist(
          {
            saleorApiUrl: ctx.saleorApiUrl!,
            appId: ctx.appId!,
          },
          createWishlistId(wishlistId),
          createUserId(ctx.userId)
        );

        if (deleteResult.isErr()) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to delete wishlist",
          });
        }

        return { success: true };
      });
  }
}
