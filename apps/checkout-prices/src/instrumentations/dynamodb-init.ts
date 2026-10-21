/**
 * DynamoDB table initialization for the Checkout Prices app.
 *
 * Run once at server start by src/instrumentation.ts when
 * INIT_DYNAMODB_ON_STARTUP=true (same pattern as apps/digital-downloads).
 * Replaces the former public, unauthenticated POST /api/setup-db route and
 * the scripts/init-dynamodb.sh that called it.
 *
 * Idempotent (describe first; a concurrent creation counts as success) and
 * NON-FATAL: any failure is logged and the server keeps starting — the first
 * DynamoDB operation then fails loudly instead of the container crash-looping
 * during a transient DynamoDB outage.
 */

import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";

import { createDynamoDBClient } from "../modules/dynamodb/dynamodb-client";
import { resolveMainTableName } from "../modules/dynamodb/main-table-name";

const logger = {
  info: (message: string, ...args: unknown[]) => console.log(`[DynamoDB Init] ${message}`, ...args),
  warn: (message: string, ...args: unknown[]) => console.warn(`[DynamoDB Init] ${message}`, ...args),
  error: (message: string, ...args: unknown[]) => console.error(`[DynamoDB Init] ${message}`, ...args),
};

export async function createTableIfNotExists(
  client: DynamoDBClient,
  tableName: string,
): Promise<"created" | "exists"> {
  logger.info(`Checking table: ${tableName}`);

  try {
    const result = await client.send(new DescribeTableCommand({ TableName: tableName }));

    if (result.Table) {
      logger.info(`✓ Table ${tableName} already exists (${result.Table.TableStatus ?? "unknown status"})`);

      return "exists";
    }
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) {
      throw error;
    }
    logger.info(`Table ${tableName} does not exist, creating...`);
  }

  try {
    // Same key schema the APL table (modules/dynamodb/dynamo-main-table.ts) expects.
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5,
        },
      }),
    );
  } catch (error) {
    // Another replica created it between our describe and create.
    if (error instanceof ResourceInUseException) {
      logger.info(`✓ Table ${tableName} is already being created`);

      return "exists";
    }
    throw error;
  }

  logger.info(`✓ Table ${tableName} created successfully`);

  return "created";
}

export async function initializeDynamoDB(client: DynamoDBClient = createDynamoDBClient()): Promise<void> {
  const tableName = resolveMainTableName();

  logger.info("Starting DynamoDB initialization...");

  try {
    await createTableIfNotExists(client, tableName);
    logger.info("DynamoDB initialization completed successfully");
  } catch (error) {
    // Don't throw — let the app start and fail on the first DB operation instead.
    logger.error(
      `Failed to initialize table ${tableName}:`,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
}
