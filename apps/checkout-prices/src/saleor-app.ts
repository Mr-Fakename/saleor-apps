import { SaleorApp } from "@saleor/app-sdk/saleor-app";
import { APL } from "@saleor/app-sdk/APL";
import { DynamoAPL } from "@saleor/app-sdk/APL/dynamodb";
import { FileAPL } from "@saleor/app-sdk/APL/file";
import { UpstashAPL } from "@saleor/app-sdk/APL/upstash";
import { HttpsEnforcingAPL } from "./lib/https-enforcing-apl";
import { dynamoMainTable } from "./modules/dynamodb/dynamo-main-table";

/**
 * By default auth data are stored in the `.auth-data.json` (FileAPL).
 * For multi-tenant applications and deployments please use UpstashAPL or DynamoAPL.
 *
 * To read more about storing auth data, read the
 * [APL documentation](https://github.com/saleor/saleor-app-sdk/blob/main/docs/apl.md)
 */

const aplType = process.env.APL ?? "file";

console.log("[SALEOR-APP] ===== Environment Variables =====");
console.log("[SALEOR-APP] APL:", process.env.APL);
console.log("[SALEOR-APP] APP_IFRAME_BASE_URL:", process.env.APP_IFRAME_BASE_URL);
console.log("[SALEOR-APP] APP_API_BASE_URL:", process.env.APP_API_BASE_URL);
console.log("[SALEOR-APP] NEXT_PUBLIC_SALEOR_API_URL:", process.env.NEXT_PUBLIC_SALEOR_API_URL);
console.log("[SALEOR-APP] =========================================");
console.log("[SALEOR-APP] Initializing APL with type:", aplType);

let baseApl: APL;

switch (aplType.toLowerCase()) {
  case "dynamodb": {
    console.log("[SALEOR-APP] Using DynamoAPL");

    // Validate required environment variables
    const requiredEnvVars = [
      "DYNAMODB_MAIN_TABLE_NAME",
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ];

    const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);

    // If endpoint is set (local dev), we can relax credentials requirement
    const hasEndpoint = process.env.AWS_ENDPOINT_URL || process.env.AWS_ENDPOINT || process.env.DYNAMODB_ENDPOINT;
    const isMissingOnlyCreds = missingVars.length === 2 && 
                               missingVars.includes("AWS_ACCESS_KEY_ID") && 
                               missingVars.includes("AWS_SECRET_ACCESS_KEY");

    if (missingVars.length > 0 && !(hasEndpoint && isMissingOnlyCreds)) {
      console.error("[SALEOR-APP] ✗ Missing required DynamoDB environment variables:", missingVars);
      // Don't throw if we have fallback for table name
      if (!process.env.CHECKOUT_PRICES_DYNAMODB_TABLE && !process.env.DYNAMODB_MAIN_TABLE_NAME) {
          throw new Error(
            `Missing required environment variables for DynamoDB: ${missingVars.join(", ")}`
          );
      }
    }

    console.log("[SALEOR-APP] DynamoDB Table:", process.env.DYNAMODB_MAIN_TABLE_NAME || process.env.CHECKOUT_PRICES_DYNAMODB_TABLE);
    console.log("[SALEOR-APP] AWS Region:", process.env.AWS_REGION || "us-east-1");
    console.log("[SALEOR-APP] AWS Endpoint:", process.env.AWS_ENDPOINT_URL || process.env.AWS_ENDPOINT || process.env.DYNAMODB_ENDPOINT || "(default)");

    baseApl = DynamoAPL.create({
      table: dynamoMainTable,
    });

    console.log("[SALEOR-APP] ✓ DynamoAPL initialized successfully");
    break;
  }

  case "upstash": {
    console.log("[SALEOR-APP] Using UpstashAPL");

    // Validate required environment variables
    if (!process.env.UPSTASH_URL || !process.env.UPSTASH_TOKEN) {
      console.error("[SALEOR-APP] ✗ Missing required Upstash environment variables");
      throw new Error("UPSTASH_URL and UPSTASH_TOKEN are required when APL=upstash");
    }

    console.log("[SALEOR-APP] Upstash URL:", process.env.UPSTASH_URL);
    baseApl = new UpstashAPL();
    console.log("[SALEOR-APP] ✓ UpstashAPL initialized successfully");
    break;
  }

  case "file":
  default: {
    console.log("[SALEOR-APP] Using FileAPL");

    // FileAPL stores data in .auth-data.json by default
    const authFilePath = process.env.APL_FILE_PATH ?? ".auth-data.json";
    console.log("[SALEOR-APP] Auth file path:", authFilePath);

    baseApl = new FileAPL();
    console.log("[SALEOR-APP] ✓ FileAPL initialized successfully");
    break;
  }
}

// Wrap the base APL with HTTPS enforcement
// This ensures all Saleor API URLs are converted from HTTP to HTTPS
export const apl = new HttpsEnforcingAPL(baseApl);

export const saleorApp = new SaleorApp({
  apl,
});

console.log("[SALEOR-APP] ✓ SaleorApp initialized with HTTPS enforcement");
