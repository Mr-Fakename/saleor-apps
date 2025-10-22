/**
 * DynamoDB Table Initialization
 *
 * This module initializes required DynamoDB tables on application startup.
 * It's imported by instrumentation.ts when INIT_DYNAMODB_ON_STARTUP=true
 */

import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";

const logger = {
  info: (message: string, ...args: unknown[]) => {
    // eslint-disable-next-line no-console
    console.log(`[DynamoDB Init] ${message}`, ...args);
  },
  error: (message: string, ...args: unknown[]) => {
    // eslint-disable-next-line no-console
    console.error(`[DynamoDB Init] ${message}`, ...args);
  },
  warn: (message: string, ...args: unknown[]) => {
    // eslint-disable-next-line no-console
    console.warn(`[DynamoDB Init] ${message}`, ...args);
  },
};

async function createTableIfNotExists(client: DynamoDBClient, tableName: string): Promise<void> {
  logger.info(`Checking table: ${tableName}`);

  try {
    // Check if table exists
    const result = await client.send(
      new DescribeTableCommand({
        TableName: tableName,
      }),
    );

    if (result.Table) {
      logger.info(`✓ Table ${tableName} already exists`);
      return;
    }
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      logger.info(`Table ${tableName} does not exist, creating...`);
    } else {
      throw error;
    }
  }

  // Create table
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        {
          AttributeName: "PK",
          AttributeType: "S",
        },
        {
          AttributeName: "SK",
          AttributeType: "S",
        },
      ],
      KeySchema: [
        {
          AttributeName: "PK",
          KeyType: "HASH",
        },
        {
          AttributeName: "SK",
          KeyType: "RANGE",
        },
      ],
      ProvisionedThroughput: {
        ReadCapacityUnits: 5,
        WriteCapacityUnits: 5,
      },
    }),
  );

  logger.info(`✓ Table ${tableName} created successfully`);
}

async function initializeDynamoDB() {
  const tableName = process.env.DYNAMODB_MAIN_TABLE_NAME;
  const awsRegion = process.env.AWS_REGION;

  if (!tableName) {
    logger.error("DYNAMODB_MAIN_TABLE_NAME is not set");
    return;
  }

  if (!awsRegion) {
    logger.error("AWS_REGION is not set");
    return;
  }

  logger.info("Starting DynamoDB initialization...");

  try {
    const dynamoClient = new DynamoDBClient({
      region: awsRegion,
    });

    await createTableIfNotExists(dynamoClient, tableName);

    logger.info("DynamoDB initialization completed successfully");
  } catch (error) {
    logger.error("Failed to initialize DynamoDB:", error);
    // Don't throw - let the app start and fail on first DB operation instead
    // This prevents the app from crashing during deployment if there are temporary AWS issues
  }
}

// Run initialization when this module is imported
await initializeDynamoDB();
