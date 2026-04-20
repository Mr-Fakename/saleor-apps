import { Entity, string } from "dynamodb-toolbox";
import { item } from "dynamodb-toolbox/schema/item";

import { DynamoMainTable, dynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";

/**
 * Access patterns for WishlistItem entity
 * PK: "WISHLIST#{wishlistId}"
 * SK: "PRODUCT#{productId}#{variantId}"
 */
class WishlistItemAccessPattern {
  static getPK({ wishlistId }: { wishlistId: string }) {
    return `WISHLIST#${wishlistId}` as const;
  }

  static getSKforSpecificItem({
    productId,
    variantId,
  }: {
    productId: string;
    variantId: string;
  }) {
    return `PRODUCT#${productId}#${variantId}` as const;
  }

  static getSKforAllItems() {
    return `PRODUCT#` as const;
  }
}

const DynamoDbWishlistItemSchema = item({
  PK: string().key(),
  SK: string().key(),
  wishlistId: string(),
  productId: string(),
  variantId: string(),
  productSlug: string(),
  productName: string(),
  addedAt: string(), // ISO date string
});

const createWishlistItemEntity = (table: DynamoMainTable) => {
  return new Entity({
    table,
    name: "WishlistItem",
    schema: DynamoDbWishlistItemSchema,
    timestamps: false, // We manage addedAt manually
  });
};

const dynamoDbWishlistItemEntity = createWishlistItemEntity(dynamoMainTable);

export type DynamoDbWishlistItemEntity = typeof dynamoDbWishlistItemEntity;

export const DynamoDbWishlistItem = {
  accessPattern: {
    getPK: WishlistItemAccessPattern.getPK,
    getSKforSpecificItem: WishlistItemAccessPattern.getSKforSpecificItem,
    getSKforAllItems: WishlistItemAccessPattern.getSKforAllItems,
  },
  entitySchema: DynamoDbWishlistItemSchema,
  createEntity: createWishlistItemEntity,
  entity: dynamoDbWishlistItemEntity,
};
