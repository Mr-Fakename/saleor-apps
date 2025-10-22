#!/usr/bin/env node

/**
 * Plain JavaScript version of DynamoDB table setup
 * Can be run in production with: node scripts/setup-dynamodb.js
 */

import { parseArgs } from "node:util";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";

// Read environment variables directly
const tableName = process.env.DYNAMODB_MAIN_TABLE_NAME;

if (!tableName) {
  console.error("ERROR: DYNAMODB_MAIN_TABLE_NAME environment variable is required");
  process.exit(1);
}

const awsRegion = process.env.AWS_REGION || "us-east-1";
const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

async function main() {
  try {
    const {
      values: { "endpoint-url": endpointUrl },
    } = parseArgs({
      args: process.argv.slice(2),
      options: {
        "endpoint-url": {
          type: "string",
          short: "e",
          default: undefined, // Use AWS defaults if not specified
        },
      },
    });

    console.log(`Starting DynamoDB setup...`);
    console.log(`Table name: ${tableName}`);
    console.log(`Region: ${awsRegion}`);
    if (endpointUrl) {
      console.log(`Endpoint: ${endpointUrl}`);
    }

    const clientConfig = {
      region: awsRegion,
    };

    // Add endpoint and credentials for local development
    if (endpointUrl) {
      clientConfig.endpoint = endpointUrl;
      clientConfig.credentials = {
        accessKeyId: awsAccessKeyId || "local",
        secretAccessKey: awsSecretAccessKey || "local",
      };
    }

    const dynamoClient = new DynamoDBClient(clientConfig);

    // Check if table exists
    try {
      const possibleTable = await dynamoClient.send(
        new DescribeTableCommand({
          TableName: tableName,
        }),
      );

      if (possibleTable.Table) {
        console.log(`✓ Table ${tableName} already exists - skipping creation`);
        process.exit(0);
      }
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        console.log(`Table ${tableName} does not exist, proceeding with creation...`);
      } else {
        throw error;
      }
    }

    // Create table
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
    console.log(`✓ Table ${tableName} created successfully`);
    console.log("DynamoDB setup completed successfully");
    process.exit(0);
  } catch (error) {
    console.error("✗ Error setting up DynamoDB:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
