import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Table } from "dynamodb-toolbox";

import {
  createDynamoDBClient,
  createDynamoDBDocumentClient,
} from "./dynamodb-client";

type PartitionKey = { name: "PK"; type: "string" };
type SortKey = { name: "SK"; type: "string" };

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

  static getPrimaryKeyScopedToInstallation({
    saleorApiUrl,
    appId,
  }: {
    saleorApiUrl: string;
    appId: string;
  }): `${string}#${string}` {
    return `${saleorApiUrl}#${appId}` as const;
  }

  static getPrimaryKeyScopedToSaleorApiUrl({
    saleorApiUrl,
  }: {
    saleorApiUrl: string;
  }): `${string}` {
    return `${saleorApiUrl}` as const;
  }
}

const client = createDynamoDBClient();
const documentClient = createDynamoDBDocumentClient(client);

const tableName = process.env.DYNAMODB_MAIN_TABLE_NAME;

if (!tableName) {
  throw new Error("DYNAMODB_MAIN_TABLE_NAME environment variable is required");
}

export const dynamoMainTable = DynamoMainTable.create({
  documentClient,
  tableName,
});
