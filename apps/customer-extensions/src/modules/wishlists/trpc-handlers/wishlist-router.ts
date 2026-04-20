import { router } from "@/modules/trpc/trpc-server";

import { CreateWishlistTrpcHandler } from "./create-wishlist-handler";
import { GetUserWishlistsTrpcHandler } from "./get-user-wishlists-handler";
import { DeleteWishlistTrpcHandler } from "./delete-wishlist-handler";
import { RenameWishlistTrpcHandler } from "./rename-wishlist-handler";
import { AddToWishlistTrpcHandler } from "./add-to-wishlist-handler";
import { RemoveFromWishlistTrpcHandler } from "./remove-from-wishlist-handler";
import { GetWishlistItemsTrpcHandler } from "./get-wishlist-items-handler";
import { GetWishlistProductsTrpcHandler } from "./get-wishlist-products-handler";

export const wishlistRouter = router({
  createWishlist: new CreateWishlistTrpcHandler().getTrpcProcedure(),
  getUserWishlists: new GetUserWishlistsTrpcHandler().getTrpcProcedure(),
  deleteWishlist: new DeleteWishlistTrpcHandler().getTrpcProcedure(),
  renameWishlist: new RenameWishlistTrpcHandler().getTrpcProcedure(),
  addToWishlist: new AddToWishlistTrpcHandler().getTrpcProcedure(),
  removeFromWishlist: new RemoveFromWishlistTrpcHandler().getTrpcProcedure(),
  getWishlistItems: new GetWishlistItemsTrpcHandler().getTrpcProcedure(),
  getWishlistProducts: new GetWishlistProductsTrpcHandler().getTrpcProcedure(),
});
