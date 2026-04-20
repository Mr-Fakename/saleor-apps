import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

export class GetWishlistProductsTrpcHandler {
  baseProcedure = protectedClientProcedure;

  getTrpcProcedure() {
    return this.baseProcedure
      .input(
        z.object({
          productIds: z.array(z.string()),
          channel: z.string().default("default-channel"),
        })
      )
      .query(async ({ input, ctx }) => {
        const { productIds, channel } = input;

        // Return empty array if no product IDs provided
        if (productIds.length === 0) {
          return [];
        }

        const productsResult = await ctx.saleorClient!.getProductsByIds({
          productIds,
          channel,
        });

        if (productsResult.isErr()) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to fetch products",
          });
        }

        // Map to simplified product data for wishlist display
        return (productsResult.value?.edges || []).map((edge) => {
          const product = edge.node;
          return {
            id: product.id,
            slug: product.slug,
            name: product.name,
            thumbnail: product.thumbnail
              ? {
                  url: product.thumbnail.url,
                  alt: product.thumbnail.alt || product.name,
                }
              : null,
            pricing: product.pricing
              ? {
                  priceRange: {
                    start: {
                      amount: product.pricing.priceRange?.start?.gross.amount,
                      currency: product.pricing.priceRange?.start?.gross.currency,
                    },
                    stop: {
                      amount: product.pricing.priceRange?.stop?.gross.amount,
                      currency: product.pricing.priceRange?.stop?.gross.currency,
                    },
                  },
                }
              : null,
            isAvailable: product.isAvailable ?? false,
            isAvailableForPurchase: product.channelListings?.some(
              (listing) => listing?.availableForPurchaseAt === null ||
                (listing?.availableForPurchaseAt && new Date(listing.availableForPurchaseAt) <= new Date())
            ) ?? false,
            variants: (product.variants || []).map((variant) => ({
              id: variant.id,
              name: variant.name,
              pricing: variant.pricing?.price?.gross
                ? {
                    amount: variant.pricing.price.gross.amount,
                    currency: variant.pricing.price.gross.currency,
                  }
                : null,
            })),
          };
        });
      });
  }
}
