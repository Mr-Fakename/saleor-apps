import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const createDynamoDBClient = () => {
  const endpoint = process.env.AWS_ENDPOINT_URL || process.env.AWS_ENDPOINT || process.env.DYNAMODB_ENDPOINT;

  const client = new DynamoDBClient({
    ...(endpoint && { endpoint }),
    region: process.env.AWS_REGION || "us-east-1",
  });

  return client;
};

export const createDynamoDBDocumentClient = (client: DynamoDBClient) => {
  return DynamoDBDocumentClient.from(client);
};
