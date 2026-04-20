import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { Wishlist } from "../domain/wishlist";
import { createUserId } from "../domain/types";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

export class CreateWishlistTrpcHandler {
  baseProcedure = protectedClientProcedure;

  getTrpcProcedure() {
    return this.baseProcedure
      .input(
        z.object({
          name: z.string().min(1).max(100),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { name } = input;

        // Get userId from authenticated context (JWT token)
        if (!ctx.userId) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "User ID not found in context",
          });
        }

        // Create domain entity
        const wishlistResult = Wishlist.create({
          userId: createUserId(ctx.userId),
          name,
        });

        if (wishlistResult.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: wishlistResult.error.message,
          });
        }

        // Save to repository
        const saveResult = await ctx.wishlistRepo!.createWishlist(
          {
            saleorApiUrl: ctx.saleorApiUrl!,
            appId: ctx.appId!,
          },
          wishlistResult.value
        );

        if (saveResult.isErr()) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create wishlist",
          });
        }

        return {
          wishlistId: wishlistResult.value.id,
          name: wishlistResult.value.name,
        };
      });
  }
}
