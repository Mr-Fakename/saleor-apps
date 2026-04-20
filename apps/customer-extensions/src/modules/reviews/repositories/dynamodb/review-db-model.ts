import { Entity, number, string } from "dynamodb-toolbox";
import { item } from "dynamodb-toolbox/schema/item";

import { DynamoMainTable, dynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";

/**
 * Access patterns for ProductReview entity
 * PK: "PRODUCT#{productId}"
 * SK: "REVIEW#{userId}#{orderId}"
 *
 * This allows us to:
 * - Query all reviews for a product efficiently
 * - Prevent duplicate reviews (same user + product + order)
 */
class ReviewAccessPattern {
  static getPK({ productId }: { productId: string }) {
    return `PRODUCT#${productId}` as const;
  }

  static getSKforSpecificReview({
    userId,
    orderId,
  }: {
    userId: string;
    orderId: string;
  }) {
    return `REVIEW#${userId}#${orderId}` as const;
  }

  static getSKforAllReviews() {
    return `REVIEW#` as const;
  }

  /**
   * Alternative: Get reviews by user
   * Would require a GSI with PK: USER#{userId}, SK: REVIEW#{productId}
   */
  static getUserPK({ userId }: { userId: string }) {
    return `USER#${userId}` as const;
  }

  static getUserSKforSpecificReview({
    productId,
    orderId,
  }: {
    productId: string;
    orderId: string;
  }) {
    return `REVIEW#${productId}#${orderId}` as const;
  }
}

const DynamoDbReviewSchema = item({
  PK: string().key(),
  SK: string().key(),
  reviewId: string(),
  productId: string(),
  userId: string(),
  orderId: string(),
  userEmail: string(),
  userName: string(),
  rating: number(),
  comment: string(),
  verifiedPurchase: string(), // 'true' or 'false' as string
  status: string().optional(), // 'pending' | 'approved' | 'deleted'
  deletedAt: string().optional(), // ISO timestamp when soft-deleted
  productName: string().optional(), // Denormalized for display
});

const createReviewEntity = (table: DynamoMainTable) => {
  return new Entity({
    table,
    name: "ProductReview",
    schema: DynamoDbReviewSchema,
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

const dynamoDbReviewEntity = createReviewEntity(dynamoMainTable);

export type DynamoDbReviewEntity = typeof dynamoDbReviewEntity;

export const DynamoDbReview = {
  accessPattern: {
    getPK: ReviewAccessPattern.getPK,
    getSKforSpecificReview: ReviewAccessPattern.getSKforSpecificReview,
    getSKforAllReviews: ReviewAccessPattern.getSKforAllReviews,
    getUserPK: ReviewAccessPattern.getUserPK,
    getUserSKforSpecificReview: ReviewAccessPattern.getUserSKforSpecificReview,
  },
  entitySchema: DynamoDbReviewSchema,
  createEntity: createReviewEntity,
  entity: dynamoDbReviewEntity,
};
