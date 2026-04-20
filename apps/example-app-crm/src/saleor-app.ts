import { APL, FileAPL, SaleorCloudAPL, UpstashAPL } from "@saleor/app-sdk/APL";
import { SaleorApp } from "@saleor/app-sdk/saleor-app";
import { HttpsEnforcingAPL } from "./lib/https-enforcing-apl";
import { DynamoAPL } from "./modules/dynamodb/dynamo-apl";
import { createDynamoDBClient, createDynamoDBDocumentClient } from "./modules/dynamodb/dynamodb-client";
import { createLogger } from "./logger";

const logger = createLogger("SaleorApp");

const aplType = process.env.APL ?? "file";

logger.info("Initializing APL", { aplType });

let baseApl: APL;

switch (aplType.toLowerCase()) {
  case "dynamodb": {
    const requiredEnvVars = [
      "DYNAMODB_MAIN_TABLE_NAME",
      "AWS_REGION",
    ];

    const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);

    if (missingVars.length > 0) {
      throw new Error(
        `Missing required environment variables for DynamoDB APL: ${missingVars.join(", ")}`,
      );
    }

    const client = createDynamoDBClient();
    const documentClient = createDynamoDBDocumentClient(client);

    baseApl = DynamoAPL.create({
      documentClient,
      tableName: process.env.DYNAMODB_MAIN_TABLE_NAME!,
    });

    logger.info("DynamoAPL initialized", {
      tableName: process.env.DYNAMODB_MAIN_TABLE_NAME,
      region: process.env.AWS_REGION,
    });

    break;
  }
  case "upstash": {
    baseApl = new UpstashAPL();

    logger.info("UpstashAPL initialized");
    break;
  }
  case "saleor-cloud": {
    if (!process.env.REST_APL_ENDPOINT || !process.env.REST_APL_TOKEN) {
      throw new Error("Rest APL is not configured - missing env variables. Check saleor-app.ts");
    }

    baseApl = new SaleorCloudAPL({
      resourceUrl: process.env.REST_APL_ENDPOINT,
      token: process.env.REST_APL_TOKEN,
    });

    logger.info("SaleorCloudAPL initialized");
    break;
  }
  case "file":
  default: {
    baseApl = new FileAPL();

    logger.info("FileAPL initialized");
    break;
  }
}

export const apl = new HttpsEnforcingAPL(baseApl);

export const saleorApp = new SaleorApp({
  apl,
});
