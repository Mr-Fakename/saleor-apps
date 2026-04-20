import type { NextApiRequest, NextApiResponse } from "next";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";

type SuccessResponse = {
  success: true;
  message: string;
  tableName: string;
  status?: string;
};

type ErrorResponse = {
  success: false;
  error: string;
  details?: string;
};

type SetupDbResponse = SuccessResponse | ErrorResponse;

/**
 * API endpoint to initialize DynamoDB tables
 *
 * This endpoint creates the required DynamoDB tables if they don't exist.
 * It's useful for deployed environments where running scripts via shell isn't possible.
 *
 * Usage:
 *   POST /api/setup-db - Create table if it doesn't exist
 *   GET /api/setup-db - Check if table exists
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<SetupDbResponse>
) {
  const tableName = process.env.DYNAMODB_MAIN_TABLE_NAME || process.env.CHECKOUT_PRICES_DYNAMODB_TABLE;
  const awsRegion = process.env.AWS_REGION || "us-east-1";
  const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const awsEndpointUrl = process.env.AWS_ENDPOINT_URL || process.env.AWS_ENDPOINT || process.env.DYNAMODB_ENDPOINT;

  console.log("[SETUP-DB] Request received:", req.method);
  console.log("[SETUP-DB] Table name (env):", tableName);
  console.log("[SETUP-DB] AWS Region:", awsRegion);
  console.log("[SETUP-DB] AWS Endpoint:", awsEndpointUrl || "(default)");
  console.log("[SETUP-DB] Environment Variables check:", {
    DYNAMODB_MAIN_TABLE_NAME: !!process.env.DYNAMODB_MAIN_TABLE_NAME,
    CHECKOUT_PRICES_DYNAMODB_TABLE: !!process.env.CHECKOUT_PRICES_DYNAMODB_TABLE,
    AWS_ENDPOINT_URL: !!process.env.AWS_ENDPOINT_URL,
    AWS_ENDPOINT: !!process.env.AWS_ENDPOINT,
    DYNAMODB_ENDPOINT: !!process.env.DYNAMODB_ENDPOINT
  });

  let effectiveTableName = tableName || "checkout-prices-main-table";
  console.log("[SETUP-DB] Effective Table Name:", effectiveTableName);

  // Validate environment variables
  if (!tableName) {
    console.warn(`[SETUP-DB] ⚠️ DYNAMODB_MAIN_TABLE_NAME is not set, using fallback: ${effectiveTableName}`);
  }

  if (!awsRegion) {
    console.error("[SETUP-DB] ✗ AWS_REGION is not set");
    return res.status(400).json({
      success: false,
      error: "AWS_REGION environment variable is not set",
    });
  }

  // Support local development without credentials if endpoint is provided
  const isLocal = awsEndpointUrl && (awsEndpointUrl.includes("localhost") || awsEndpointUrl.includes("dynamodb"));

  if (!isLocal && (!awsAccessKeyId || !awsSecretAccessKey)) {
    console.error("[SETUP-DB] ✗ AWS credentials are not set");
    return res.status(400).json({
      success: false,
      error: "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables are required",
    });
  }

  try {
    // Create DynamoDB client
    const dynamoClient = new DynamoDBClient({
      region: awsRegion,
      ...(awsAccessKeyId && awsSecretAccessKey && {
        credentials: {
          accessKeyId: awsAccessKeyId,
          secretAccessKey: awsSecretAccessKey,
        },
      }),
      ...(isLocal && !awsAccessKeyId && {
        credentials: {
          accessKeyId: "local",
          secretAccessKey: "local",
        },
      }),
      ...(awsEndpointUrl && { endpoint: awsEndpointUrl }),
    });

    console.log("[SETUP-DB] DynamoDB client created");

    // Handle GET request - just check if table exists
    if (req.method === "GET") {
      console.log("[SETUP-DB] Checking table status...");

      try {
        const result = await dynamoClient.send(
          new DescribeTableCommand({
            TableName: effectiveTableName,
          })
        );

        console.log("[SETUP-DB] ✓ Table exists, status:", result.Table?.TableStatus);

        return res.status(200).json({
          success: true,
          message: `Table ${effectiveTableName} exists`,
          tableName: effectiveTableName,
          status: result.Table?.TableStatus,
        });
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          console.log("[SETUP-DB] Table does not exist");
          return res.status(404).json({
            success: false,
            error: "Table does not exist. Call POST /api/setup-db to create it.",
          });
        }
        throw error;
      }
    }

    // Handle POST request - create table if it doesn't exist
    if (req.method === "POST") {
      console.log("[SETUP-DB] Checking if table exists...");

      // Check if table already exists
      try {
        const possibleTable = await dynamoClient.send(
          new DescribeTableCommand({
            TableName: effectiveTableName,
          })
        );

        if (possibleTable.Table) {
          console.log(`[SETUP-DB] ✓ Table ${effectiveTableName} already exists - skipping creation`);
          return res.status(200).json({
            success: true,
            message: `Table ${effectiveTableName} already exists`,
            tableName: effectiveTableName,
            status: possibleTable.Table.TableStatus,
          });
        }
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          console.log(`[SETUP-DB] Table ${effectiveTableName} does not exist, creating...`);
        } else {
          throw error;
        }
      }

      // Create the table
      console.log("[SETUP-DB] Creating table...");
      const createTableCommand = new CreateTableCommand({
        TableName: effectiveTableName,
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
      console.log(`[SETUP-DB] ✓ Table ${effectiveTableName} created successfully`);

      return res.status(201).json({
        success: true,
        message: `Table ${effectiveTableName} created successfully`,
        tableName: effectiveTableName,
      });
    }

    // Method not allowed
    return res.status(405).json({
      success: false,
      error: "Method not allowed. Use GET or POST.",
    });
  } catch (error) {
    console.error("[SETUP-DB] ✗ Error:", error);

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      details: error instanceof Error ? error.stack : undefined,
    });
  }
}
