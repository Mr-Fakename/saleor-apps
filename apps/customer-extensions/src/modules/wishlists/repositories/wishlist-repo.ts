import { Result } from "neverthrow";

import { BaseError } from "@/lib/errors";

import { Wishlist } from "../domain/wishlist";
import { WishlistItem } from "../domain/wishlist-item";
import { ProductId, UserId, VariantId, WishlistId } from "../domain/types";

export type BaseAccessPattern = {
  saleorApiUrl: string;
  appId: string;
};

export const WishlistRepoError = {
  FailureCreatingWishlist: BaseError.subclass("FailureCreatingWishlistError", {
    props: {
      _internalName: "WishlistRepoError.FailureCreatingWishlist",
    },
  }),
  FailureFetchingWishlists: BaseError.subclass("FailureFetchingWishlistsError", {
    props: {
      _internalName: "WishlistRepoError.FailureFetchingWishlists",
    },
  }),
  FailureDeletingWishlist: BaseError.subclass("FailureDeletingWishlistError", {
    props: {
      _internalName: "WishlistRepoError.FailureDeletingWishlist",
    },
  }),
  FailureAddingItem: BaseError.subclass("FailureAddingItemError", {
    props: {
      _internalName: "WishlistRepoError.FailureAddingItem",
    },
  }),
  FailureRemovingItem: BaseError.subclass("FailureRemovingItemError", {
    props: {
      _internalName: "WishlistRepoError.FailureRemovingItem",
    },
  }),
  FailureFetchingItems: BaseError.subclass("FailureFetchingItemsError", {
    props: {
      _internalName: "WishlistRepoError.FailureFetchingItems",
    },
  }),
  FailureRenamingWishlist: BaseError.subclass("FailureRenamingWishlistError", {
    props: {
      _internalName: "WishlistRepoError.FailureRenamingWishlist",
    },
  }),
};

export interface WishlistRepo {
  createWishlist: (
    access: BaseAccessPattern,
    wishlist: Wishlist
  ) => Promise<
    Result<null, InstanceType<typeof WishlistRepoError.FailureCreatingWishlist>>
  >;

  getUserWishlists: (
    access: BaseAccessPattern,
    userId: UserId
  ) => Promise<
    Result<Wishlist[], InstanceType<typeof WishlistRepoError.FailureFetchingWishlists>>
  >;

  getWishlistById: (
    access: BaseAccessPattern,
    wishlistId: WishlistId
  ) => Promise<
    Result<Wishlist | null, InstanceType<typeof WishlistRepoError.FailureFetchingWishlists>>
  >;

  deleteWishlist: (
    access: BaseAccessPattern,
    wishlistId: WishlistId,
    userId: UserId
  ) => Promise<
    Result<null, InstanceType<typeof WishlistRepoError.FailureDeletingWishlist>>
  >;

  addItemToWishlist: (
    access: BaseAccessPattern,
    item: WishlistItem
  ) => Promise<
    Result<null, InstanceType<typeof WishlistRepoError.FailureAddingItem>>
  >;

  removeItemFromWishlist: (
    access: BaseAccessPattern,
    wishlistId: WishlistId,
    productId: ProductId,
    variantId: VariantId
  ) => Promise<
    Result<null, InstanceType<typeof WishlistRepoError.FailureRemovingItem>>
  >;

  getWishlistItems: (
    access: BaseAccessPattern,
    wishlistId: WishlistId
  ) => Promise<
    Result<WishlistItem[], InstanceType<typeof WishlistRepoError.FailureFetchingItems>>
  >;

  renameWishlist: (
    access: BaseAccessPattern,
    wishlistId: WishlistId,
    userId: UserId,
    newName: string
  ) => Promise<
    Result<null, InstanceType<typeof WishlistRepoError.FailureRenamingWishlist>>
  >;
}
