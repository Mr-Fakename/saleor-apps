import { DeleteItemCommand, GetItemCommand, PutItemCommand } from "dynamodb-toolbox";
import { QueryCommand } from "dynamodb-toolbox/table/actions/query";
import { err, ok, Result } from "neverthrow";

import { createLogger } from "@/lib/logger";

import { Wishlist } from "../../domain/wishlist";
import { WishlistItem } from "../../domain/wishlist-item";
import {
  createProductId,
  createProductSlug,
  createUserId,
  createVariantId,
  createWishlistId,
  ProductId,
  UserId,
  VariantId,
  WishlistId,
} from "../../domain/types";
import {
  BaseAccessPattern,
  WishlistRepo,
  WishlistRepoError,
} from "../wishlist-repo";
import {
  DynamoDbWishlist,
  DynamoDbWishlistEntity,
} from "./wishlist-db-model";
import {
  DynamoDbWishlistItem,
  DynamoDbWishlistItemEntity,
} from "./wishlist-item-db-model";

type ConstructorParams = {
  entities: {
    wishlist: DynamoDbWishlistEntity;
    wishlistItem: DynamoDbWishlistItemEntity;
  };
};

export class DynamodbWishlistRepo implements WishlistRepo {
  private logger = createLogger("DynamodbWishlistRepo");

  wishlistEntity: DynamoDbWishlistEntity;
  wishlistItemEntity: DynamoDbWishlistItemEntity;

  constructor(
    config: ConstructorParams = {
      entities: {
        wishlist: DynamoDbWishlist.entity,
        wishlistItem: DynamoDbWishlistItem.entity,
      },
    }
  ) {
    this.wishlistEntity = config.entities.wishlist;
    this.wishlistItemEntity = config.entities.wishlistItem;
  }

  async createWishlist(
    access: BaseAccessPattern,
    wishlist: Wishlist
  ): Promise<
    Result<null, InstanceType<typeof WishlistRepoError.FailureCreatingWishlist>>
  > {
    try {
      const dbData = wishlist.toDatabase();

      await this.wishlistEntity
        .build(PutItemCommand)
        .item({
          PK: DynamoDbWishlist.accessPattern.getPK({ userId: dbData.userId }),
          SK: DynamoDbWishlist.accessPattern.getSKforSpecificItem({
            wishlistId: dbData.id,
          }),
          wishlistId: dbData.id,
          userId: dbData.userId,
          name: dbData.name,
          createdAt: dbData.createdAt.toISOString(),
          modifiedAt: dbData.modifiedAt.toISOString(),
        })
        .send();

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to create wishlist", { error, wishlist });
      return err(
        new WishlistRepoError.FailureCreatingWishlist("Failed to create wishlist", {
          cause: error,
        })
      );
    }
  }

  async getUserWishlists(
    access: BaseAccessPattern,
    userId: UserId
  ): Promise<
    Result<
      Wishlist[],
      InstanceType<typeof WishlistRepoError.FailureFetchingWishlists>
    >
  > {
    try {
      const query = this.wishlistEntity.table
        .build(QueryCommand)
        .entities(this.wishlistEntity)
        .query({
          partition: DynamoDbWishlist.accessPattern.getPK({ userId }),
          range: {
            beginsWith: DynamoDbWishlist.accessPattern.getSKforAllItems(),
          },
        })
        .options({ maxPages: Infinity });

      const result = await query.send();

      const wishlists = (result.Items || []).map((item) =>
        Wishlist.fromDatabase({
          id: createWishlistId(item.wishlistId),
          userId: createUserId(item.userId),
          name: item.name,
          createdAt: new Date(item.createdAt),
          modifiedAt: new Date(item.modifiedAt),
        })
      );

      return ok(wishlists);
    } catch (error) {
      this.logger.error("Failed to fetch user wishlists", { error, userId });
      return err(
        new WishlistRepoError.FailureFetchingWishlists(
          "Failed to fetch user wishlists",
          {
            cause: error,
          }
        )
      );
    }
  }

  async getWishlistById(
    access: BaseAccessPattern,
    wishlistId: WishlistId
  ): Promise<
    Result<
      Wishlist | null,
      InstanceType<typeof WishlistRepoError.FailureFetchingWishlists>
    >
  > {
    try {
      // Note: We need userId to construct the PK, but we don't have it here
      // For now, we'll need to scan or use a GSI
      // This is a limitation of the current access pattern
      // TODO: Consider adding a GSI with wishlistId as PK

      this.logger.warn(
        "getWishlistById not fully implemented - requires userId or GSI"
      );
      return ok(null);
    } catch (error) {
      this.logger.error("Failed to fetch wishlist by ID", { error, wishlistId });
      return err(
        new WishlistRepoError.FailureFetchingWishlists(
          "Failed to fetch wishlist by ID",
          {
            cause: error,
          }
        )
      );
    }
  }

  async deleteWishlist(
    access: BaseAccessPattern,
    wishlistId: WishlistId,
    userId: UserId
  ): Promise<
    Result<null, InstanceType<typeof WishlistRepoError.FailureDeletingWishlist>>
  > {
    try {
      // First delete all items in the wishlist
      const itemsResult = await this.getWishlistItems(access, wishlistId);

      if (itemsResult.isOk()) {
        await Promise.all(
          itemsResult.value.map((item) =>
            this.removeItemFromWishlist(
              access,
              wishlistId,
              item.productId,
              item.variantId
            )
          )
        );
      }

      // Then delete the wishlist itself
      await this.wishlistEntity
        .build(DeleteItemCommand)
        .key({
          PK: DynamoDbWishlist.accessPattern.getPK({ userId }),
          SK: DynamoDbWishlist.accessPattern.getSKforSpecificItem({ wishlistId }),
        })
        .send();

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to delete wishlist", { error, wishlistId });
      return err(
        new WishlistRepoError.FailureDeletingWishlist("Failed to delete wishlist", {
          cause: error,
        })
      );
    }
  }

  async addItemToWishlist(
    access: BaseAccessPattern,
    item: WishlistItem
  ): Promise<Result<null, InstanceType<typeof WishlistRepoError.FailureAddingItem>>> {
    try {
      const dbData = item.toDatabase();

      await this.wishlistItemEntity
        .build(PutItemCommand)
        .item({
          PK: DynamoDbWishlistItem.accessPattern.getPK({
            wishlistId: dbData.wishlistId,
          }),
          SK: DynamoDbWishlistItem.accessPattern.getSKforSpecificItem({
            productId: dbData.productId,
            variantId: dbData.variantId,
          }),
          wishlistId: dbData.wishlistId,
          productId: dbData.productId,
          variantId: dbData.variantId,
          productSlug: dbData.productSlug,
          productName: dbData.productName,
          addedAt: dbData.addedAt.toISOString(),
        })
        .send();

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to add item to wishlist", { error, item });
      return err(
        new WishlistRepoError.FailureAddingItem("Failed to add item to wishlist", {
          cause: error,
        })
      );
    }
  }

  async removeItemFromWishlist(
    access: BaseAccessPattern,
    wishlistId: WishlistId,
    productId: ProductId,
    variantId: VariantId
  ): Promise<Result<null, InstanceType<typeof WishlistRepoError.FailureRemovingItem>>> {
    try {
      await this.wishlistItemEntity
        .build(DeleteItemCommand)
        .key({
          PK: DynamoDbWishlistItem.accessPattern.getPK({ wishlistId }),
          SK: DynamoDbWishlistItem.accessPattern.getSKforSpecificItem({
            productId,
            variantId,
          }),
        })
        .send();

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to remove item from wishlist", {
        error,
        wishlistId,
        productId,
        variantId,
      });
      return err(
        new WishlistRepoError.FailureRemovingItem(
          "Failed to remove item from wishlist",
          {
            cause: error,
          }
        )
      );
    }
  }

  async getWishlistItems(
    access: BaseAccessPattern,
    wishlistId: WishlistId
  ): Promise<
    Result<WishlistItem[], InstanceType<typeof WishlistRepoError.FailureFetchingItems>>
  > {
    try {
      const query = this.wishlistItemEntity.table
        .build(QueryCommand)
        .entities(this.wishlistItemEntity)
        .query({
          partition: DynamoDbWishlistItem.accessPattern.getPK({ wishlistId }),
          range: {
            beginsWith: DynamoDbWishlistItem.accessPattern.getSKforAllItems(),
          },
        })
        .options({ maxPages: Infinity });

      const result = await query.send();

      const items = (result.Items || []).map((item) => {
        // Handle legacy items without productSlug (use productId as fallback)
        const slug = item.productSlug || item.productId || "unknown";
        return WishlistItem.fromDatabase({
          wishlistId: createWishlistId(item.wishlistId),
          productId: createProductId(item.productId),
          variantId: createVariantId(item.variantId),
          productSlug: createProductSlug(slug),
          productName: item.productName,
          addedAt: new Date(item.addedAt),
        });
      });

      return ok(items);
    } catch (error) {
      this.logger.error("Failed to fetch wishlist items", { error, wishlistId });
      return err(
        new WishlistRepoError.FailureFetchingItems("Failed to fetch wishlist items", {
          cause: error,
        })
      );
    }
  }

  async renameWishlist(
    access: BaseAccessPattern,
    wishlistId: WishlistId,
    userId: UserId,
    newName: string
  ): Promise<
    Result<null, InstanceType<typeof WishlistRepoError.FailureRenamingWishlist>>
  > {
    try {
      // First fetch the existing wishlist to get createdAt
      const query = this.wishlistEntity.table
        .build(QueryCommand)
        .entities(this.wishlistEntity)
        .query({
          partition: DynamoDbWishlist.accessPattern.getPK({ userId }),
          range: {
            eq: DynamoDbWishlist.accessPattern.getSKforSpecificItem({ wishlistId }),
          },
        })
        .options({ maxPages: 1 });

      const result = await query.send();
      const existingWishlist = result.Items?.[0];

      if (!existingWishlist) {
        this.logger.error("Wishlist not found for rename", { wishlistId, userId });
        return err(
          new WishlistRepoError.FailureRenamingWishlist("Wishlist not found", {
            cause: new Error("Wishlist not found"),
          })
        );
      }

      // Update the wishlist with new name and modifiedAt
      await this.wishlistEntity
        .build(PutItemCommand)
        .item({
          PK: DynamoDbWishlist.accessPattern.getPK({ userId }),
          SK: DynamoDbWishlist.accessPattern.getSKforSpecificItem({ wishlistId }),
          wishlistId: existingWishlist.wishlistId,
          userId: existingWishlist.userId,
          name: newName,
          createdAt: existingWishlist.createdAt,
          modifiedAt: new Date().toISOString(),
        })
        .send();

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to rename wishlist", { error, wishlistId, newName });
      return err(
        new WishlistRepoError.FailureRenamingWishlist("Failed to rename wishlist", {
          cause: error,
        })
      );
    }
  }
}

// Export singleton instance
export const dynamodbWishlistRepo = new DynamodbWishlistRepo();
