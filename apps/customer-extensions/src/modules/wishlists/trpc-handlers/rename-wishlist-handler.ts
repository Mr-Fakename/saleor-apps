import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createUserId, createWishlistId } from "../domain/types";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

export class RenameWishlistTrpcHandler {
  baseProcedure = protectedClientProcedure;

  getTrpcProcedure() {
    return this.baseProcedure
      .input(
        z.object({
          wishlistId: z.string().uuid(),
          name: z.string().min(1).max(100),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { wishlistId, name } = input;

        // Get userId from authenticated context (JWT token)
        if (!ctx.userId) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "User ID not found in context",
          });
        }

        // Validate name (additional validation beyond Zod)
        const trimmedName = name.trim();
        if (trimmedName.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Wishlist name cannot be empty",
          });
        }

        if (trimmedName.length > 100) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Wishlist name cannot exceed 100 characters",
          });
        }

        // Rename wishlist
        const renameResult = await ctx.wishlistRepo!.renameWishlist(
          {
            saleorApiUrl: ctx.saleorApiUrl!,
            appId: ctx.appId!,
          },
          createWishlistId(wishlistId),
          createUserId(ctx.userId),
          trimmedName
        );

        if (renameResult.isErr()) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to rename wishlist",
          });
        }

        return { success: true };
      });
  }
}
