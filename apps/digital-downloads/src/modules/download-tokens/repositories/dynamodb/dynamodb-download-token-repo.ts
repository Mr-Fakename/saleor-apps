import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { err, ok, Result } from "neverthrow";

import { createLogger } from "@/lib/logger";
import { env } from "@/lib/env";
import {
  createDynamoDBClient,
  createDynamoDBDocumentClient,
} from "@/modules/dynamodb/dynamodb-client";
import { DownloadToken } from "@/modules/download-tokens/domain/download-token";
import {
  DownloadTokenRepo,
  DownloadTokenRepoError,
  DownloadTokenRepoErrors,
} from "@/modules/download-tokens/repositories/download-token-repo";
import {
  DownloadTokenDbModel,
  DownloadTokenEntity,
} from "@/modules/download-tokens/repositories/dynamodb/download-token-db-model";

const logger = createLogger("DynamoDBDownloadTokenRepo");

export class DynamoDBDownloadTokenRepo implements DownloadTokenRepo {
  private client: DynamoDBDocumentClient;
  private tableName: string;

  constructor({ client, tableName }: { client: DynamoDBDocumentClient; tableName: string }) {
    this.client = client;
    this.tableName = tableName;
  }

  private mapDbModelToDomain(dbModel: DownloadTokenDbModel): DownloadToken {
    return {
      token: dbModel.token as DownloadToken["token"],
      orderId: dbModel.orderId,
      orderNumber: dbModel.orderNumber,
      customerId: dbModel.customerId,
      customerEmail: dbModel.customerEmail,
      fileUrl: dbModel.fileUrl,
      productName: dbModel.productName,
      variantName: dbModel.variantName,
      expiresAt: dbModel.expiresAt,
      maxDownloads: dbModel.maxDownloads,
      downloadCount: dbModel.downloadCount,
      createdAt: dbModel.createdAt,
      lastAccessedAt: dbModel.lastAccessedAt,
    };
  }

  private mapDomainToDbModel(token: DownloadToken): DownloadTokenDbModel {
    return {
      PK: DownloadTokenEntity.getPrimaryKey({ token: token.token }),
      SK: DownloadTokenEntity.getSortKey(),
      token: token.token,
      orderId: token.orderId,
      orderNumber: token.orderNumber,
      customerId: token.customerId,
      customerEmail: token.customerEmail,
      fileUrl: token.fileUrl,
      productName: token.productName,
      variantName: token.variantName,
      expiresAt: token.expiresAt,
      maxDownloads: token.maxDownloads,
      downloadCount: token.downloadCount,
      createdAt: token.createdAt,
      lastAccessedAt: token.lastAccessedAt,
    };
  }

  async save(token: DownloadToken): Promise<Result<DownloadToken, DownloadTokenRepoError>> {
    try {
      logger.debug("Saving download token", { token: token.token });

      const dbModel = this.mapDomainToDbModel(token);

      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: dbModel,
        }),
      );

      logger.info("Download token saved successfully", { token: token.token });

      return ok(token);
    } catch (error) {
      logger.error("Failed to save download token", { error, token: token.token });

      return err(
        new DownloadTokenRepoErrors.SaveError("Failed to save download token", {
          cause: error,
        }),
      );
    }
  }

  async getByToken(token: string): Promise<Result<DownloadToken, DownloadTokenRepoError>> {
    try {
      logger.debug("Fetching download token", { token });

      const result = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: {
            PK: DownloadTokenEntity.getPrimaryKey({ token }),
            SK: DownloadTokenEntity.getSortKey(),
          },
        }),
      );

      if (!result.Item) {
        logger.warn("Download token not found", { token });

        return err(
          new DownloadTokenRepoErrors.NotFoundError("Download token not found", {
            cause: { token },
          }),
        );
      }

      const downloadToken = this.mapDbModelToDomain(result.Item as DownloadTokenDbModel);

      logger.debug("Download token fetched successfully", { token });

      return ok(downloadToken);
    } catch (error) {
      logger.error("Failed to fetch download token", { error, token });

      return err(
        new DownloadTokenRepoErrors.FetchError("Failed to fetch download token", {
          cause: error,
        }),
      );
    }
  }

  async incrementDownloadCount(
    token: string,
  ): Promise<Result<DownloadToken, DownloadTokenRepoError>> {
    try {
      logger.debug("Incrementing download count", { token });

      const updateResult = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: {
            PK: DownloadTokenEntity.getPrimaryKey({ token }),
            SK: DownloadTokenEntity.getSortKey(),
          },
          UpdateExpression: "SET downloadCount = downloadCount + :inc, lastAccessedAt = :timestamp",
          ExpressionAttributeValues: {
            ":inc": 1,
            ":timestamp": new Date().toISOString(),
          },
          ReturnValues: "ALL_NEW",
        }),
      );

      if (!updateResult.Attributes) {
        return err(
          new DownloadTokenRepoErrors.NotFoundError("Download token not found", {
            cause: { token },
          }),
        );
      }

      const updatedToken = this.mapDbModelToDomain(updateResult.Attributes as DownloadTokenDbModel);

      logger.info("Download count incremented successfully", {
        token,
        newCount: updatedToken.downloadCount,
      });

      return ok(updatedToken);
    } catch (error) {
      logger.error("Failed to increment download count", { error, token });

      return err(
        new DownloadTokenRepoErrors.UpdateError("Failed to increment download count", {
          cause: error,
        }),
      );
    }
  }

  async delete(token: string): Promise<Result<void, DownloadTokenRepoError>> {
    try {
      logger.debug("Deleting download token", { token });

      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: {
            PK: DownloadTokenEntity.getPrimaryKey({ token }),
            SK: DownloadTokenEntity.getSortKey(),
          },
        }),
      );

      logger.info("Download token deleted successfully", { token });

      return ok(undefined);
    } catch (error) {
      logger.error("Failed to delete download token", { error, token });

      return err(
        new DownloadTokenRepoErrors.DeleteError("Failed to delete download token", {
          cause: error,
        }),
      );
    }
  }

  async listByOrder(orderId: string): Promise<Result<DownloadToken[], DownloadTokenRepoError>> {
    try {
      logger.debug("Listing download tokens for order", { orderId });

      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "OrderIndex", // You would need to create a GSI for this
          KeyConditionExpression: "orderId = :orderId",
          ExpressionAttributeValues: {
            ":orderId": orderId,
          },
        }),
      );

      const tokens = (result.Items || []).map((item) =>
        this.mapDbModelToDomain(item as DownloadTokenDbModel),
      );

      logger.debug("Download tokens listed successfully", {
        orderId,
        count: tokens.length,
      });

      return ok(tokens);
    } catch (error) {
      logger.error("Failed to list download tokens", { error, orderId });

      return err(
        new DownloadTokenRepoErrors.FetchError("Failed to list download tokens", {
          cause: error,
        }),
      );
    }
  }
}

// Create singleton instance
const client = createDynamoDBClient();
const documentClient = createDynamoDBDocumentClient(client);

export const dynamoDBDownloadTokenRepo = new DynamoDBDownloadTokenRepo({
  client: documentClient,
  tableName: env.DYNAMODB_MAIN_TABLE_NAME,
});
