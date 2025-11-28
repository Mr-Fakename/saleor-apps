/* eslint-disable no-console */
/**
 * Migration Script: Add OrderIndex GSI to existing DynamoDB table
 *
 * This script adds the OrderIndex Global Secondary Index to an existing table.
 * It's needed for querying download tokens by orderId.
 *
 * Usage:
 *   pnpm tsx scripts/add-order-index.ts
 *
 * For AWS DynamoDB (production):
 *   AWS_REGION=us-east-1 pnpm tsx scripts/add-order-index.ts
 */

import {
  DynamoDBClient,
  UpdateTableCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";

import { env } from "@/lib/env";

const tableName = env.DYNAMODB_MAIN_TABLE_NAME;

async function addOrderIndex() {
  console.log(`Starting migration: Adding OrderIndex to table ${tableName}`);

  // Create DynamoDB client
  const dynamoClient = new DynamoDBClient({
    region: env.AWS_REGION,
    ...(process.env.AWS_ENDPOINT_URL && { endpoint: process.env.AWS_ENDPOINT_URL }),
  });

  try {
    // First, check if the table exists and get its current state
    console.log(`Checking table ${tableName}...`);
    const describeResult = await dynamoClient.send(
      new DescribeTableCommand({
        TableName: tableName,
      }),
    );

    // Check if OrderIndex already exists
    const existingIndexes = describeResult.Table?.GlobalSecondaryIndexes || [];
    const orderIndexExists = existingIndexes.some((index) => index.IndexName === "OrderIndex");

    if (orderIndexExists) {
      console.log("✓ OrderIndex already exists, no migration needed");
      return;
    }

    console.log("OrderIndex does not exist, adding it now...");

    // Add the Global Secondary Index
    await dynamoClient.send(
      new UpdateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          {
            AttributeName: "orderId",
            AttributeType: "S",
          },
        ],
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: "OrderIndex",
              KeySchema: [
                {
                  AttributeName: "orderId",
                  KeyType: "HASH",
                },
              ],
              Projection: {
                ProjectionType: "ALL",
              },
              ProvisionedThroughput: {
                ReadCapacityUnits: 5,
                WriteCapacityUnits: 5,
              },
            },
          },
        ],
      }),
    );

    console.log("✓ OrderIndex created successfully");
    console.log("");
    console.log("Note: The index is being created in the background.");
    console.log("It may take a few minutes to become ACTIVE, especially for large tables.");
    console.log("You can check the status with: aws dynamodb describe-table --table-name", tableName);
  } catch (error) {
    console.error("Failed to add OrderIndex:", error);
    throw error;
  }
}

addOrderIndex()
  .then(() => {
    console.log("\nMigration completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\nMigration failed:", error);
    process.exit(1);
  });
