import { NextResponse } from "next/server";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";

const logger = createLogger("setup-db");

/**
 * API endpoint to initialize DynamoDB tables
 *
 * This endpoint creates the required DynamoDB tables if they don't exist.
 * It's useful for deployed environments where running scripts via shell isn't possible.
 *
 * Usage: POST /api/setup-db
 *
 * Security: Consider adding authentication/authorization before using in production
 */
export async function POST() {
  try {
    logger.info("Starting DynamoDB setup via API endpoint");

    const tableName = env.DYNAMODB_MAIN_TABLE_NAME;

    // Create DynamoDB client using environment configuration
    // AWS SDK automatically reads AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY from process.env
    const dynamoClient = new DynamoDBClient({
      // Optional: AWS_ENDPOINT_URL for local development or custom endpoints
      ...(process.env.AWS_ENDPOINT_URL && { endpoint: process.env.AWS_ENDPOINT_URL }),
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });

    // Check if table already exists
    try {
      const possibleTable = await dynamoClient.send(
        new DescribeTableCommand({
          TableName: tableName,
        }),
      );

      if (possibleTable.Table) {
        logger.info(`Table ${tableName} already exists - creation is skipped`);
        return NextResponse.json({
          success: true,
          message: `Table ${tableName} already exists`,
          tableName,
        });
      }
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        logger.info(`Table ${tableName} does not exist, proceeding with creation`);
      } else {
        throw error;
      }
    }

    // Create the table
    const createTableCommand = new CreateTableCommand({
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
    });

    await dynamoClient.send(createTableCommand);
    logger.info(`Table ${tableName} created successfully`);

    return NextResponse.json({
      success: true,
      message: `Table ${tableName} created successfully`,
      tableName,
    });
  } catch (error) {
    logger.error("Error setting up DynamoDB", { error });

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        details: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 },
    );
  }
}

// Also support GET for convenience (just checks status)
export async function GET() {
  try {
    const tableName = env.DYNAMODB_MAIN_TABLE_NAME;

    const dynamoClient = new DynamoDBClient({
      ...(process.env.AWS_ENDPOINT_URL && { endpoint: process.env.AWS_ENDPOINT_URL }),
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const result = await dynamoClient.send(
      new DescribeTableCommand({
        TableName: tableName,
      }),
    );

    return NextResponse.json({
      success: true,
      message: `Table ${tableName} exists`,
      tableName,
      status: result.Table?.TableStatus,
    });
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      return NextResponse.json(
        {
          success: false,
          message: "Table does not exist. Call POST /api/setup-db to create it.",
          error: "Table not found",
        },
        { status: 404 },
      );
    }

    logger.error("Error checking DynamoDB table", { error });

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
