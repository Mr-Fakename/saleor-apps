/* eslint-disable no-console */
import { parseArgs } from "node:util";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";

// Read from environment variables or use defaults
const tableName = process.env.DYNAMODB_MAIN_TABLE_NAME || "digital-downloads-main-table";
const awsRegion = process.env.AWS_REGION || "localhost";
const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID || "local";
const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "local";

try {
  const {
    values: { "endpoint-url": endpointUrl },
  } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "endpoint-url": {
        type: "string",
        short: "e",
        default: process.env.AWS_ENDPOINT_URL || "http://localhost:8001",
      },
    },
  });

  console.log(`Starting DynamoDB setup with endpoint: ${endpointUrl}`);
  console.log(`Table name: ${tableName}`);
  console.log(`Region: ${awsRegion}`);

  const dynamoClient = new DynamoDBClient({
    endpoint: endpointUrl,
    region: awsRegion,
    credentials: {
      accessKeyId: awsAccessKeyId,
      secretAccessKey: awsSecretAccessKey,
    },
  });

  const createTableIfNotExists = async (tableNameToCreate) => {
    try {
      const possibleTable = await dynamoClient.send(
        new DescribeTableCommand({
          TableName: tableNameToCreate,
        }),
      );

      if (possibleTable.Table) {
        console.log(`✓ Table ${tableNameToCreate} already exists - creation is skipped`);
        return;
      }
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        console.log(`Table ${tableNameToCreate} does not exist, proceeding with creation.`);
      } else {
        throw error;
      }
    }

    const createTableCommand = new CreateTableCommand({
      TableName: tableNameToCreate,
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
    console.log(`✓ Table ${tableNameToCreate} created successfully`);
  };

  await createTableIfNotExists(tableName);

  console.log("✓ DynamoDB setup completed successfully");
  process.exit(0);
} catch (error) {
  console.error("✗ Error setting up DynamoDB:", error);
  process.exit(1);
}
