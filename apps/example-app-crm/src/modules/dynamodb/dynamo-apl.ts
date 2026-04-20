import { APL, AuthData } from "@saleor/app-sdk/APL";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { createLogger } from "../../logger";

const logger = createLogger("DynamoAPL");

/**
 * Custom DynamoDB-backed APL implementation.
 * Stores auth data in a DynamoDB table with PK = saleorApiUrl, SK = "APL".
 * Compatible with @saleor/app-sdk 0.50.x APL interface.
 */
export class DynamoAPL implements APL {
  private readonly documentClient: DynamoDBDocumentClient;
  private readonly tableName: string;

  private constructor(documentClient: DynamoDBDocumentClient, tableName: string) {
    this.documentClient = documentClient;
    this.tableName = tableName;
  }

  static create({ documentClient, tableName }: { documentClient: DynamoDBDocumentClient; tableName: string }): DynamoAPL {
    return new DynamoAPL(documentClient, tableName);
  }

  async get(saleorApiUrl: string): Promise<AuthData | undefined> {
    try {
      const result = await this.documentClient.send(
        new GetCommand({
          TableName: this.tableName,
          Key: {
            PK: saleorApiUrl,
            SK: "APL",
          },
        }),
      );

      if (!result.Item) {
        return undefined;
      }

      return {
        domain: result.Item.domain as string,
        token: result.Item.token as string,
        saleorApiUrl: result.Item.saleorApiUrl as string,
        appId: result.Item.appId as string,
        jwks: result.Item.jwks as string,
      };
    } catch (error) {
      logger.error("Failed to get auth data from DynamoDB", { error, saleorApiUrl });
      return undefined;
    }
  }

  async set(authData: AuthData): Promise<void> {
    try {
      await this.documentClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            PK: authData.saleorApiUrl,
            SK: "APL",
            domain: authData.domain,
            token: authData.token,
            saleorApiUrl: authData.saleorApiUrl,
            appId: authData.appId,
            jwks: authData.jwks,
          },
        }),
      );

      logger.info("Auth data saved to DynamoDB", { saleorApiUrl: authData.saleorApiUrl });
    } catch (error) {
      logger.error("Failed to save auth data to DynamoDB", { error });
      throw error;
    }
  }

  async delete(saleorApiUrl: string): Promise<void> {
    try {
      await this.documentClient.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: {
            PK: saleorApiUrl,
            SK: "APL",
          },
        }),
      );

      logger.info("Auth data deleted from DynamoDB", { saleorApiUrl });
    } catch (error) {
      logger.error("Failed to delete auth data from DynamoDB", { error });
      throw error;
    }
  }

  async getAll(): Promise<AuthData[]> {
    try {
      const result = await this.documentClient.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: "SK = :sk",
          ExpressionAttributeValues: {
            ":sk": "APL",
          },
        }),
      );

      return (result.Items ?? []).map((item) => ({
        domain: item.domain as string,
        token: item.token as string,
        saleorApiUrl: item.saleorApiUrl as string,
        appId: item.appId as string,
        jwks: item.jwks as string,
      }));
    } catch (error) {
      logger.error("Failed to get all auth data from DynamoDB", { error });
      return [];
    }
  }

  async isReady() {
    return { ready: true as const };
  }

  async isConfigured() {
    return { configured: true as const };
  }
}
