import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Table } from "dynamodb-toolbox";

import {
  createDynamoDBClient,
  createDynamoDBDocumentClient,
} from "./dynamodb-client";

type PartitionKey = { name: "PK"; type: "string" };
type SortKey = { name: "SK"; type: "string" };

/**
 * This table is used to store all relevant data for the Checkout Prices application,
 * including APL (Auth Persistence Layer) data and configuration.
 */
export class DynamoMainTable extends Table<PartitionKey, SortKey> {
  private constructor(args: ConstructorParameters<typeof Table<PartitionKey, SortKey>>[number]) {
    super(args);
  }

  static create({
    documentClient,
    tableName,
  }: {
    documentClient: DynamoDBDocumentClient;
    tableName: string;
  }): DynamoMainTable {
    return new DynamoMainTable({
      documentClient,
      name: tableName,
      partitionKey: { name: "PK", type: "string" },
      sortKey: {
        name: "SK",
        type: "string",
      },
    });
  }

  /**
   * These PKs will be scoped per installation, so reinstalling the app will not access this data.
   * Use Case: Logs, config, transactions.
   */
  static getPrimaryKeyScopedToInstallation({
    saleorApiUrl,
    appId,
  }: {
    saleorApiUrl: string;
    appId: string;
  }): `${string}#${string}` {
    return `${saleorApiUrl}#${appId}` as const;
  }

  /**
   * These PKs will be scoped to tenant, so even after reinstalling they will be accessible.
   * Use case: APL
   */
  static getPrimaryKeyScopedToSaleorApiUrl({
    saleorApiUrl,
  }: {
    saleorApiUrl: string;
  }): `${string}` {
    return `${saleorApiUrl}` as const;
  }
}

const tableName = process.env.DYNAMODB_MAIN_TABLE_NAME || process.env.CHECKOUT_PRICES_DYNAMODB_TABLE;

if (!tableName) {
  console.warn("[DynamoDB] DYNAMODB_MAIN_TABLE_NAME or CHECKOUT_PRICES_DYNAMODB_TABLE is not set - DynamoDB features will not be available");
}

const client = createDynamoDBClient();
const documentClient = createDynamoDBDocumentClient(client);

export const dynamoMainTable = DynamoMainTable.create({
  documentClient: documentClient,
  tableName: tableName || "checkout-prices-main-table", // Fallback for safety
});
