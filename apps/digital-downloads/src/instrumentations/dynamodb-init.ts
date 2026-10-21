/**
 * DynamoDB Table Initialization for Digital Downloads App
 *
 * This module initializes required DynamoDB tables on application startup.
 * It's imported by instrumentation.ts when INIT_DYNAMODB_ON_STARTUP=true
 *
 * It is the only runtime path that creates schema (the unauthenticated `/api/setup-db` route
 * was removed). It ensures:
 * - the main table (PK/SK), and
 * - the `OrderIndex` GSI (hash key `orderId`) used by `DynamoDBDownloadTokenRepo.listByOrder`,
 *   previously only created by the manual `scripts/add-order-index.ts`.
 *
 * Every step is idempotent and failures never crash the app.
 */

import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type GlobalSecondaryIndex,
  ResourceNotFoundException,
  type TableDescription,
  UpdateTableCommand,
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

export const ORDER_INDEX_NAME = "OrderIndex";

const DEFAULT_PROVISIONED_THROUGHPUT = {
  ReadCapacityUnits: 5,
  WriteCapacityUnits: 5,
};

const isPayPerRequest = (table: TableDescription | undefined) =>
  table?.BillingModeSummary?.BillingMode === "PAY_PER_REQUEST";

/**
 * GSI definition shared by table creation and the migration of existing tables.
 * Matches `scripts/add-order-index.ts`. Provisioned throughput is only valid on PROVISIONED tables.
 */
const buildOrderIndex = ({ payPerRequest }: { payPerRequest: boolean }): GlobalSecondaryIndex => ({
  IndexName: ORDER_INDEX_NAME,
  KeySchema: [
    {
      AttributeName: "orderId",
      KeyType: "HASH",
    },
  ],
  Projection: {
    ProjectionType: "ALL",
  },
  ...(payPerRequest ? {} : { ProvisionedThroughput: DEFAULT_PROVISIONED_THROUGHPUT }),
});

/**
 * Creates the main table (with the OrderIndex GSI) if it does not exist.
 *
 * @returns the description of the existing table, or `undefined` when it was just created
 * (a newly created table already carries the GSI).
 */
export async function createTableIfNotExists(
  client: DynamoDBClient,
  tableName: string,
): Promise<TableDescription | undefined> {
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

      return result.Table;
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
        {
          AttributeName: "orderId",
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
      GlobalSecondaryIndexes: [buildOrderIndex({ payPerRequest: false })],
      ProvisionedThroughput: DEFAULT_PROVISIONED_THROUGHPUT,
    }),
  );

  logger.info(`✓ Table ${tableName} created successfully (with ${ORDER_INDEX_NAME})`);

  return undefined;
}

/**
 * Adds the OrderIndex GSI to an existing table when it is missing. Idempotent: a GSI that is
 * already present (any status, including CREATING) is left alone.
 *
 * Never throws: a failure (e.g. table busy, missing permission) is logged and retried on the
 * next start. The manual fallback is `pnpm tsx scripts/add-order-index.ts`.
 */
export async function ensureOrderIndex(
  client: DynamoDBClient,
  tableName: string,
  table: TableDescription,
): Promise<void> {
  const hasOrderIndex = (table.GlobalSecondaryIndexes ?? []).some(
    (index) => index.IndexName === ORDER_INDEX_NAME,
  );

  if (hasOrderIndex) {
    logger.info(`✓ ${ORDER_INDEX_NAME} already exists on ${tableName}`);

    return;
  }

  logger.info(`${ORDER_INDEX_NAME} missing on ${tableName}, adding it...`);

  try {
    await client.send(
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
            Create: buildOrderIndex({ payPerRequest: isPayPerRequest(table) }),
          },
        ],
      }),
    );

    logger.info(
      `✓ ${ORDER_INDEX_NAME} creation started on ${tableName} (it becomes ACTIVE in the background)`,
    );
  } catch (error) {
    logger.error(
      `Failed to add ${ORDER_INDEX_NAME} to ${tableName}; order download listing will fail until it exists. ` +
        "It is retried on the next start (fallback: pnpm tsx scripts/add-order-index.ts).",
      error,
    );
  }
}

export async function initializeDynamoDB() {
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

    const existingTable = await createTableIfNotExists(dynamoClient, tableName);

    if (existingTable) {
      await ensureOrderIndex(dynamoClient, tableName, existingTable);
    }

    logger.info("DynamoDB initialization completed successfully");
  } catch (error) {
    logger.error("Failed to initialize DynamoDB:", error);
    // Don't throw - let the app start and fail on first DB operation instead
    // This prevents the app from crashing during deployment if there are temporary AWS issues
  }
}

// Run initialization when this module is imported
await initializeDynamoDB();
