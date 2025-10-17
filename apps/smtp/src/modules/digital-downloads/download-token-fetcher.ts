import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { err, ok, Result } from "neverthrow";

import { BaseError } from "../../errors";
import { createLogger } from "../../logger";
import { createDynamoDBClient, createDynamoDBDocumentClient } from "../dynamodb/dynamodb-client";

const logger = createLogger("DownloadTokenFetcher");

export interface DownloadToken {
  token: string;
  orderId: string;
  orderNumber: string;
  customerId?: string;
  customerEmail?: string;
  fileUrl: string;
  productName: string;
  variantName?: string;
  expiresAt: string;
  maxDownloads: number;
  downloadCount: number;
  createdAt: string;
  lastAccessedAt?: string;
  downloadUrl: string; // Constructed download URL
}

export class DownloadTokenFetcherError extends BaseError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DownloadTokenFetcherError";
  }
}

export class DownloadTokenFetcher {
  private client;
  private tableName: string;
  private downloadAppBaseUrl: string;

  constructor({
    tableName,
    downloadAppBaseUrl,
  }: {
    tableName: string;
    downloadAppBaseUrl: string;
  }) {
    const dynamoClient = createDynamoDBClient();

    this.client = createDynamoDBDocumentClient(dynamoClient);
    this.tableName = tableName;
    this.downloadAppBaseUrl = downloadAppBaseUrl;
  }

  /**
   * Fetches download tokens for a given order ID from DynamoDB
   * These tokens are created by the digital-downloads app
   */
  async fetchDownloadTokensByOrderId(
    orderId: string,
  ): Promise<Result<DownloadToken[], DownloadTokenFetcherError>> {
    try {
      logger.debug("Fetching download tokens for order", { orderId });

      /*
       * Query using the GSI if it exists, or scan with filter
       * The digital-downloads app needs to have an OrderIndex GSI configured
       */
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "OrderIndex", // GSI on orderId
          KeyConditionExpression: "orderId = :orderId",
          ExpressionAttributeValues: {
            ":orderId": orderId,
          },
        }),
      );

      if (!result.Items || result.Items.length === 0) {
        logger.info("No download tokens found for order", { orderId });

        return ok([]);
      }

      const tokens: DownloadToken[] = result.Items.map((item) => ({
        token: item.token as string,
        orderId: item.orderId as string,
        orderNumber: item.orderNumber as string,
        customerId: item.customerId as string | undefined,
        customerEmail: item.customerEmail as string | undefined,
        fileUrl: item.fileUrl as string,
        productName: item.productName as string,
        variantName: item.variantName as string | undefined,
        expiresAt: item.expiresAt as string,
        maxDownloads: item.maxDownloads as number,
        downloadCount: item.downloadCount as number,
        createdAt: item.createdAt as string,
        lastAccessedAt: item.lastAccessedAt as string | undefined,
        downloadUrl: `${this.downloadAppBaseUrl}/api/downloads/${item.token}`,
      }));

      logger.info("Successfully fetched download tokens", {
        orderId,
        count: tokens.length,
      });

      return ok(tokens);
    } catch (error) {
      logger.error("Failed to fetch download tokens", {
        errorName: error instanceof Error ? error.name : "Unknown",
        errorMessage: error instanceof Error ? error.message : "Unknown error",
        orderId,
      });

      /*
       * If the OrderIndex GSI doesn't exist, this will fail
       * We should handle this gracefully
       */
      if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "ValidationException"
      ) {
        logger.warn(
          "OrderIndex GSI not found on DynamoDB table. Digital downloads integration requires this GSI to be configured.",
        );

        return ok([]); // Return empty array instead of error
      }

      return err(
        new DownloadTokenFetcherError("Failed to fetch download tokens from DynamoDB", {
          cause: error,
        }),
      );
    }
  }
}

// Singleton instance
let fetcherInstance: DownloadTokenFetcher | null = null;

export const getDownloadTokenFetcher = (): DownloadTokenFetcher => {
  if (!fetcherInstance) {
    const tableName = process.env.DYNAMODB_MAIN_TABLE_NAME || "";
    const downloadAppBaseUrl =
      process.env.DIGITAL_DOWNLOADS_APP_URL || "https://digital-downloads.example.com";

    if (!tableName) {
      throw new Error("DYNAMODB_MAIN_TABLE_NAME environment variable is required");
    }

    fetcherInstance = new DownloadTokenFetcher({
      tableName,
      downloadAppBaseUrl,
    });
  }

  return fetcherInstance;
};
