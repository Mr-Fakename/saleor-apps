import { Entity, string } from "dynamodb-toolbox";
import { item } from "dynamodb-toolbox/schema/item";

import { DynamoMainTable, dynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";

/**
 * Access patterns for OrderUnlock entity
 * PK: "ORDER_UNLOCKS"
 * SK: "{orderId}"
 *
 * This allows us to:
 * - Query all unlocked orders efficiently
 * - Check if a specific order is unlocked by orderId
 * - Prevent duplicate unlocks (same orderId)
 */
class OrderUnlockAccessPattern {
  static getPK() {
    return `ORDER_UNLOCKS` as const;
  }

  static getSKforSpecificOrder({ orderId }: { orderId: string }) {
    return `${orderId}` as const;
  }
}

const DynamoDbOrderUnlockSchema = item({
  PK: string().key(),
  SK: string().key(),
  orderId: string(),
  orderNumber: string(), // Human-readable order number
  customerEmail: string(), // Denormalized for display
  unlockedAt: string(), // ISO timestamp
  unlockedById: string(), // Staff user ID
  unlockedByEmail: string(), // Staff email
});

const createOrderUnlockEntity = (table: DynamoMainTable) => {
  return new Entity({
    table,
    name: "OrderUnlock",
    schema: DynamoDbOrderUnlockSchema,
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

const dynamoDbOrderUnlockEntity = createOrderUnlockEntity(dynamoMainTable);

export type DynamoDbOrderUnlockEntity = typeof dynamoDbOrderUnlockEntity;

export const DynamoDbOrderUnlock = {
  accessPattern: {
    getPK: OrderUnlockAccessPattern.getPK,
    getSKforSpecificOrder: OrderUnlockAccessPattern.getSKforSpecificOrder,
  },
  entitySchema: DynamoDbOrderUnlockSchema,
  createEntity: createOrderUnlockEntity,
  entity: dynamoDbOrderUnlockEntity,
};
