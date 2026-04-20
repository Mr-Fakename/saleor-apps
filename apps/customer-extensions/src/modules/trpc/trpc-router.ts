import { router } from "./trpc-server";
import { wishlistRouter } from "@/modules/wishlists/trpc-handlers/wishlist-router";
import { reviewRouter } from "@/modules/reviews/trpc-handlers/review-router";

export const trpcRouter = router({
  wishlists: wishlistRouter,
  reviews: reviewRouter,
});

export type TrpcRouter = typeof trpcRouter;
