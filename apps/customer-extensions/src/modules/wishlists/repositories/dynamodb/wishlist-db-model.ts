import { Entity, string } from "dynamodb-toolbox";
import { item } from "dynamodb-toolbox/schema/item";

import { DynamoMainTable, dynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";

/**
 * Access patterns for Wishlist entity
 * PK: "USER#{userId}"
 * SK: "WISHLIST#{wishlistId}"
 */
class WishlistAccessPattern {
  static getPK({ userId }: { userId: string }) {
    return `USER#${userId}` as const;
  }

  static getSKforSpecificItem({ wishlistId }: { wishlistId: string }) {
    return `WISHLIST#${wishlistId}` as const;
  }

  static getSKforAllItems() {
    return `WISHLIST#` as const;
  }
}

const DynamoDbWishlistSchema = item({
  PK: string().key(),
  SK: string().key(),
  wishlistId: string(),
  userId: string(),
  name: string(),
});

const createWishlistEntity = (table: DynamoMainTable) => {
  return new Entity({
    table,
    name: "Wishlist",
    schema: DynamoDbWishlistSchema,
    timestamps: {
      created: {
        name: "createdAt",
        savedAs: "createdAt",
      },
      modified: {
        name: "modifiedAt",
        savedAs: "modifiedAt",
      },
    },
  });
};

const dynamoDbWishlistEntity = createWishlistEntity(dynamoMainTable);

export type DynamoDbWishlistEntity = typeof dynamoDbWishlistEntity;

export const DynamoDbWishlist = {
  accessPattern: {
    getPK: WishlistAccessPattern.getPK,
    getSKforSpecificItem: WishlistAccessPattern.getSKforSpecificItem,
    getSKforAllItems: WishlistAccessPattern.getSKforAllItems,
  },
  entitySchema: DynamoDbWishlistSchema,
  createEntity: createWishlistEntity,
  entity: dynamoDbWishlistEntity,
};
