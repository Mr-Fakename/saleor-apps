import { DeleteItemCommand, PutItemCommand } from "dynamodb-toolbox";
import { QueryCommand } from "dynamodb-toolbox/table/actions/query";
import { err, ok, Result } from "neverthrow";

import { createLogger } from "@/lib/logger";
import { createProductId, createUserId, ProductId, UserId } from "@/modules/wishlists/domain/types";

import { ProductReview } from "../../domain/product-review";
import { createOrderId, createRating, createReviewId, ReviewId, ReviewStatus } from "../../domain/types";
import { BaseAccessPattern, ReviewRepo, ReviewRepoError } from "../review-repo";
import { DynamoDbReview, DynamoDbReviewEntity } from "./review-db-model";

type ConstructorParams = {
  entities: {
    review: DynamoDbReviewEntity;
  };
};

export class DynamodbReviewRepo implements ReviewRepo {
  private logger = createLogger("DynamodbReviewRepo");

  reviewEntity: DynamoDbReviewEntity;

  constructor(
    config: ConstructorParams = {
      entities: {
        review: DynamoDbReview.entity,
      },
    }
  ) {
    this.reviewEntity = config.entities.review;
  }

  async saveReview(
    access: BaseAccessPattern,
    review: ProductReview
  ): Promise<Result<null, InstanceType<typeof ReviewRepoError.FailureSavingReview>>> {
    try {
      const dbData = review.toDatabase();

      // Use conditional write to prevent duplicate reviews (same user + product)
      await this.reviewEntity
        .build(PutItemCommand)
        .item({
          PK: DynamoDbReview.accessPattern.getPK({ productId: dbData.productId }),
          SK: DynamoDbReview.accessPattern.getSKforSpecificReview({
            userId: dbData.userId,
            orderId: dbData.orderId,
          }),
          reviewId: dbData.reviewId,
          productId: dbData.productId,
          userId: dbData.userId,
          orderId: dbData.orderId,
          userEmail: dbData.userEmail,
          userName: dbData.userName,
          rating: dbData.rating,
          comment: dbData.comment,
          verifiedPurchase: String(dbData.verifiedPurchase),
          createdAt: dbData.createdAt.toISOString(),
          modifiedAt: dbData.modifiedAt.toISOString(),
          status: dbData.status,
          deletedAt: dbData.deletedAt?.toISOString(),
          productName: dbData.productName ?? undefined,
        })
        .options({
          condition: { attr: "PK", exists: false }, // Prevent duplicates
        })
        .send();

      return ok(null);
    } catch (error: any) {
      // Check if it's a conditional check failure (duplicate review)
      if (error.name === "ConditionalCheckFailedException") {
        this.logger.warn("Duplicate review attempted", {
          productId: review.productId,
          userId: review.userId,
        });
        return err(
          new ReviewRepoError.DuplicateReview(
            "User has already reviewed this product from this order",
            { cause: error }
          )
        );
      }

      this.logger.error("Failed to save review", { error, review });
      return err(
        new ReviewRepoError.FailureSavingReview("Failed to save review", {
          cause: error,
        })
      );
    }
  }

  async getProductReviews(
    access: BaseAccessPattern,
    productId: ProductId
  ): Promise<
    Result<ProductReview[], InstanceType<typeof ReviewRepoError.FailureFetchingReviews>>
  > {
    try {
      const query = this.reviewEntity.table
        .build(QueryCommand)
        .entities(this.reviewEntity)
        .query({
          partition: DynamoDbReview.accessPattern.getPK({ productId }),
          range: {
            beginsWith: DynamoDbReview.accessPattern.getSKforAllReviews(),
          },
        })
        .options({ maxPages: Infinity });

      const result = await query.send();

      const reviews = (result.Items || []).map((item) =>
        ProductReview.fromDatabase({
          reviewId: createReviewId(item.reviewId),
          productId: createProductId(item.productId),
          userId: createUserId(item.userId),
          orderId: createOrderId(item.orderId),
          userEmail: item.userEmail,
          userName: item.userName,
          rating: createRating(item.rating),
          comment: item.comment,
          verifiedPurchase: item.verifiedPurchase === "true",
          createdAt: new Date(item.createdAt),
          modifiedAt: new Date(item.modifiedAt),
          status: (item.status as ReviewStatus) ?? "pending",
          deletedAt: item.deletedAt ? new Date(item.deletedAt) : null,
          productName: item.productName ?? null,
        })
      );

      return ok(reviews);
    } catch (error) {
      this.logger.error("Failed to fetch product reviews", { error, productId });
      return err(
        new ReviewRepoError.FailureFetchingReviews("Failed to fetch product reviews", {
          cause: error,
        })
      );
    }
  }

  async getUserReviews(
    access: BaseAccessPattern,
    userId: UserId
  ): Promise<
    Result<ProductReview[], InstanceType<typeof ReviewRepoError.FailureFetchingReviews>>
  > {
    try {
      // Note: This requires scanning or a GSI with USER#{userId} as PK
      // For now, we'll return empty array with a warning
      this.logger.warn("getUserReviews not fully implemented - requires GSI or scan");
      return ok([]);
    } catch (error) {
      this.logger.error("Failed to fetch user reviews", { error, userId });
      return err(
        new ReviewRepoError.FailureFetchingReviews("Failed to fetch user reviews", {
          cause: error,
        })
      );
    }
  }

  async getReviewById(
    access: BaseAccessPattern,
    reviewId: ReviewId,
    productId: ProductId
  ): Promise<
    Result<ProductReview | null, InstanceType<typeof ReviewRepoError.FailureFetchingReviews>>
  > {
    try {
      // Note: We need userId and orderId to construct the SK
      // This method has limited utility without those
      this.logger.warn("getReviewById not fully implemented - requires userId and orderId");
      return ok(null);
    } catch (error) {
      this.logger.error("Failed to fetch review by ID", { error, reviewId });
      return err(
        new ReviewRepoError.FailureFetchingReviews("Failed to fetch review by ID", {
          cause: error,
        })
      );
    }
  }

  async updateReview(
    access: BaseAccessPattern,
    review: ProductReview
  ): Promise<Result<null, InstanceType<typeof ReviewRepoError.FailureUpdatingReview>>> {
    try {
      const dbData = review.toDatabase();

      // Update by replacing the entire item
      await this.reviewEntity
        .build(PutItemCommand)
        .item({
          PK: DynamoDbReview.accessPattern.getPK({ productId: dbData.productId }),
          SK: DynamoDbReview.accessPattern.getSKforSpecificReview({
            userId: dbData.userId,
            orderId: dbData.orderId,
          }),
          reviewId: dbData.reviewId,
          productId: dbData.productId,
          userId: dbData.userId,
          orderId: dbData.orderId,
          userEmail: dbData.userEmail,
          userName: dbData.userName,
          rating: dbData.rating,
          comment: dbData.comment,
          verifiedPurchase: String(dbData.verifiedPurchase),
          createdAt: dbData.createdAt.toISOString(),
          modifiedAt: dbData.modifiedAt.toISOString(),
          status: dbData.status,
          deletedAt: dbData.deletedAt?.toISOString(),
          productName: dbData.productName ?? undefined,
        })
        .send();

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to update review", { error, review });
      return err(
        new ReviewRepoError.FailureUpdatingReview("Failed to update review", {
          cause: error,
        })
      );
    }
  }

  async deleteReview(
    access: BaseAccessPattern,
    productId: ProductId,
    userId: UserId,
    orderId: string
  ): Promise<Result<null, InstanceType<typeof ReviewRepoError.FailureDeletingReview>>> {
    try {
      await this.reviewEntity
        .build(DeleteItemCommand)
        .key({
          PK: DynamoDbReview.accessPattern.getPK({ productId }),
          SK: DynamoDbReview.accessPattern.getSKforSpecificReview({
            userId,
            orderId,
          }),
        })
        .send();

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to delete review", {
        error,
        productId,
        userId,
        orderId,
      });
      return err(
        new ReviewRepoError.FailureDeletingReview("Failed to delete review", {
          cause: error,
        })
      );
    }
  }

  async hasUserReviewedProduct(
    access: BaseAccessPattern,
    userId: UserId,
    productId: ProductId
  ): Promise<
    Result<boolean, InstanceType<typeof ReviewRepoError.FailureFetchingReviews>>
  > {
    try {
      // Query all reviews for the product and check if user has reviewed
      const reviewsResult = await this.getProductReviews(access, productId);

      if (reviewsResult.isErr()) {
        return err(reviewsResult.error);
      }

      const hasReviewed = reviewsResult.value.some(
        (review) => review.userId === userId
      );

      return ok(hasReviewed);
    } catch (error) {
      this.logger.error("Failed to check if user has reviewed product", {
        error,
        userId,
        productId,
      });
      return err(
        new ReviewRepoError.FailureFetchingReviews(
          "Failed to check if user has reviewed product",
          { cause: error }
        )
      );
    }
  }

  async getAllReviews(
    access: BaseAccessPattern,
    filter?: { status?: ReviewStatus[] }
  ): Promise<
    Result<ProductReview[], InstanceType<typeof ReviewRepoError.FailureFetchingReviews>>
  > {
    try {
      this.logger.debug("Fetching all reviews via table scan", { filter });

      // Use scan to get all reviews across all products
      // This is acceptable for admin dashboards but would not scale for customer-facing features
      const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
      const { DynamoDBDocumentClient, ScanCommand } = await import("@aws-sdk/lib-dynamodb");

      const client = new DynamoDBClient({});
      const docClient = DynamoDBDocumentClient.from(client);

      const tableName = process.env.DYNAMODB_MAIN_TABLE_NAME;
      if (!tableName) {
        throw new Error("DYNAMODB_MAIN_TABLE_NAME environment variable is not set");
      }

      const scanCommand = new ScanCommand({
        TableName: tableName,
        FilterExpression: "begins_with(SK, :reviewPrefix)",
        ExpressionAttributeValues: {
          ":reviewPrefix": "REVIEW#",
        },
      });

      const result = await docClient.send(scanCommand);

      let reviews = (result.Items || []).map((item) =>
        ProductReview.fromDatabase({
          reviewId: createReviewId(item.reviewId),
          productId: createProductId(item.productId),
          userId: createUserId(item.userId),
          orderId: createOrderId(item.orderId),
          userEmail: item.userEmail,
          userName: item.userName,
          rating: createRating(item.rating),
          comment: item.comment,
          verifiedPurchase: item.verifiedPurchase === "true",
          createdAt: new Date(item.createdAt),
          modifiedAt: new Date(item.modifiedAt),
          status: (item.status as ReviewStatus) ?? "pending",
          deletedAt: item.deletedAt ? new Date(item.deletedAt) : null,
          productName: item.productName ?? null,
        })
      );

      // Apply status filter if provided
      if (filter?.status && filter.status.length > 0) {
        reviews = reviews.filter((review) => filter.status!.includes(review.status));
      }

      this.logger.debug(`Fetched ${reviews.length} reviews from all products`);
      return ok(reviews);
    } catch (error) {
      this.logger.error("Failed to fetch all reviews", { error });
      return err(
        new ReviewRepoError.FailureFetchingReviews("Failed to fetch all reviews", {
          cause: error,
        })
      );
    }
  }

  async adminDeleteReview(
    access: BaseAccessPattern,
    productId: ProductId,
    userId: UserId,
    orderId: string
  ): Promise<Result<null, InstanceType<typeof ReviewRepoError.FailureDeletingReview>>> {
    // Admin delete is same as regular delete, but can be called by staff
    return this.deleteReview(access, productId, userId, orderId);
  }

  async approveReview(
    access: BaseAccessPattern,
    productId: ProductId,
    userId: UserId,
    orderId: string
  ): Promise<Result<null, InstanceType<typeof ReviewRepoError.FailureApprovingReview>>> {
    try {
      this.logger.debug("Approving review", { productId, userId, orderId });

      const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
      const { DynamoDBDocumentClient, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");

      const client = new DynamoDBClient({});
      const docClient = DynamoDBDocumentClient.from(client);

      const tableName = process.env.DYNAMODB_MAIN_TABLE_NAME;
      if (!tableName) {
        throw new Error("DYNAMODB_MAIN_TABLE_NAME environment variable is not set");
      }

      const updateCommand = new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: DynamoDbReview.accessPattern.getPK({ productId }),
          SK: DynamoDbReview.accessPattern.getSKforSpecificReview({ userId, orderId }),
        },
        UpdateExpression: "SET #status = :status, modifiedAt = :modifiedAt",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":status": "approved",
          ":modifiedAt": new Date().toISOString(),
        },
      });

      await docClient.send(updateCommand);
      this.logger.debug("Review approved successfully", { productId, userId, orderId });

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to approve review", { error, productId, userId, orderId });
      return err(
        new ReviewRepoError.FailureApprovingReview("Failed to approve review", {
          cause: error,
        })
      );
    }
  }

  async softDeleteReview(
    access: BaseAccessPattern,
    productId: ProductId,
    userId: UserId,
    orderId: string
  ): Promise<Result<null, InstanceType<typeof ReviewRepoError.FailureUpdatingReview>>> {
    try {
      this.logger.debug("Soft deleting review", { productId, userId, orderId });

      const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
      const { DynamoDBDocumentClient, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");

      const client = new DynamoDBClient({});
      const docClient = DynamoDBDocumentClient.from(client);

      const tableName = process.env.DYNAMODB_MAIN_TABLE_NAME;
      if (!tableName) {
        throw new Error("DYNAMODB_MAIN_TABLE_NAME environment variable is not set");
      }

      const now = new Date().toISOString();

      const updateCommand = new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: DynamoDbReview.accessPattern.getPK({ productId }),
          SK: DynamoDbReview.accessPattern.getSKforSpecificReview({ userId, orderId }),
        },
        UpdateExpression: "SET #status = :status, deletedAt = :deletedAt, modifiedAt = :modifiedAt",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":status": "deleted",
          ":deletedAt": now,
          ":modifiedAt": now,
        },
      });

      await docClient.send(updateCommand);
      this.logger.debug("Review soft deleted successfully", { productId, userId, orderId });

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to soft delete review", { error, productId, userId, orderId });
      return err(
        new ReviewRepoError.FailureUpdatingReview("Failed to soft delete review", {
          cause: error,
        })
      );
    }
  }
}

// Export singleton instance
export const dynamodbReviewRepo = new DynamodbReviewRepo();
