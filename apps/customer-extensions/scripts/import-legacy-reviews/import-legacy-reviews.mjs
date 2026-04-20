#!/usr/bin/env node
/**
 * Legacy Review Importer → DynamoDB
 *
 * Reads scraped reviews from legacy-reviews.json, maps product slugs to Saleor
 * product IDs via product-mapping.json, and writes directly to DynamoDB.
 *
 * Setup:
 *   1. Run scrape-legacy-reviews.mjs first to generate legacy-reviews.json
 *   2. Create product-mapping.json (see template below)
 *   3. Set environment variables:
 *      - DYNAMODB_MAIN_TABLE_NAME (the shared DynamoDB table)
 *      - AWS_REGION (default: eu-west-1)
 *      - AWS credentials (via env vars, profile, or IAM role)
 *
 * Usage:
 *   node scripts/import-legacy-reviews.mjs                    # dry run (default)
 *   node scripts/import-legacy-reviews.mjs --execute          # actually write to DynamoDB
 *   node scripts/import-legacy-reviews.mjs --generate-mapping # generate product-mapping template
 *
 * product-mapping.json format:
 * {
 *   "dy-1": { "productId": "UHJvZHVjdDox", "productName": "DY-1 Buffer" },
 *   "sp-6": { "productId": "UHJvZHVjdDoy", "productName": "SP-6 Switcher" },
 *   ...
 * }
 *
 * Reviews without a mapping are skipped (logged as warnings).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REVIEWS_FILE = path.join(__dirname, "legacy-reviews.json");
const MAPPING_FILE = path.join(__dirname, "product-mapping.json");

const TABLE_NAME = process.env.DYNAMODB_MAIN_TABLE_NAME;
const AWS_REGION = process.env.AWS_REGION || "eu-west-1";

const DRY_RUN = !process.argv.includes("--execute");
const GENERATE_MAPPING = process.argv.includes("--generate-mapping");

// --- Helpers ---

/**
 * Generate a deterministic ID from input strings.
 * Same inputs always produce the same ID → idempotent imports.
 */
function deterministicId(prefix, ...parts) {
  const hash = crypto
    .createHash("sha256")
    .update(parts.join("|"))
    .digest("hex")
    .substring(0, 16);
  return `${prefix}_${hash}`;
}

/**
 * Generate a UUID-like review ID (deterministic for idempotency)
 */
function deterministicUuid(...parts) {
  const hash = crypto
    .createHash("sha256")
    .update(parts.join("|"))
    .digest("hex");
  // Format as UUID-like: 8-4-4-4-12
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    hash.substring(12, 16),
    hash.substring(16, 20),
    hash.substring(20, 32),
  ].join("-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Generate mapping template ---

function generateMappingTemplate() {
  if (!fs.existsSync(REVIEWS_FILE)) {
    console.error(`Error: ${REVIEWS_FILE} not found. Run scrape-legacy-reviews.mjs first.`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(REVIEWS_FILE, "utf-8"));
  const template = {};

  for (const product of data.products) {
    template[product.slug] = {
      productId: "TODO_SALEOR_PRODUCT_ID",
      productName: product.productTitle || product.slug,
      _url: product.url,
      _reviewCount: product.reviewCount,
    };
  }

  const outputPath = path.join(__dirname, "product-mapping.json");
  fs.writeFileSync(outputPath, JSON.stringify(template, null, 2), "utf-8");
  console.log(`Generated mapping template: ${outputPath}`);
  console.log(`Products with reviews: ${Object.keys(template).length}`);
  console.log("\nEdit the file and replace TODO_SALEOR_PRODUCT_ID with actual Saleor product IDs.");
  console.log("Remove _url and _reviewCount fields (they are for reference only).");
  process.exit(0);
}

// --- Import ---

async function main() {
  if (GENERATE_MAPPING) {
    generateMappingTemplate();
    return;
  }

  // Validate inputs
  if (!fs.existsSync(REVIEWS_FILE)) {
    console.error(`Error: ${REVIEWS_FILE} not found. Run scrape-legacy-reviews.mjs first.`);
    process.exit(1);
  }
  if (!fs.existsSync(MAPPING_FILE)) {
    console.error(`Error: ${MAPPING_FILE} not found.`);
    console.error("Run: node scripts/import-legacy-reviews.mjs --generate-mapping");
    process.exit(1);
  }
  if (!TABLE_NAME) {
    console.error("Error: DYNAMODB_MAIN_TABLE_NAME environment variable is required.");
    process.exit(1);
  }

  const reviews = JSON.parse(fs.readFileSync(REVIEWS_FILE, "utf-8"));
  const mapping = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf-8"));

  if (DRY_RUN) {
    console.log("=== DRY RUN (use --execute to write to DynamoDB) ===\n");
  } else {
    console.log("=== EXECUTING: Writing to DynamoDB ===\n");
  }

  console.log(`Table:    ${TABLE_NAME}`);
  console.log(`Region:   ${AWS_REGION}`);
  console.log(`Reviews:  ${reviews.totalReviews}`);
  console.log(`Products: ${reviews.products.length}\n`);

  // Set up DynamoDB client
  let docClient;
  if (!DRY_RUN) {
    const client = new DynamoDBClient({ region: AWS_REGION });
    docClient = DynamoDBDocumentClient.from(client);
  }

  let imported = 0;
  let skippedNoMapping = 0;
  let skippedNoDate = 0;
  let failed = 0;

  for (const product of reviews.products) {
    const productMapping = mapping[product.slug];

    if (!productMapping || productMapping.productId === "TODO_SALEOR_PRODUCT_ID") {
      console.log(`⚠ SKIP ${product.slug} (${product.reviewCount} reviews) — no product mapping`);
      skippedNoMapping += product.reviewCount;
      continue;
    }

    const { productId, productName } = productMapping;
    console.log(`\n→ ${product.slug} → ${productId} (${product.reviewCount} reviews)`);

    for (const review of product.reviews) {
      // Generate deterministic IDs from slug + username + date (idempotent)
      const userId = deterministicId("LEGACY_USER", product.slug, review.userName, review.rawDate);
      const orderId = deterministicId("LEGACY_ORDER", product.slug, review.userName, review.rawDate);
      const reviewId = deterministicUuid(product.slug, review.userName, review.rawDate);

      const createdAt = review.createdAt || new Date().toISOString();
      if (!review.createdAt) {
        console.log(`  ⚠ No date for review #${review.number} by ${review.userName}, using now`);
        skippedNoDate++;
      }

      const item = {
        PK: `PRODUCT#${productId}`,
        SK: `REVIEW#${userId}#${orderId}`,
        _et: "ProductReview", // dynamodb-toolbox entity type discriminator
        reviewId,
        productId,
        userId,
        orderId,
        userEmail: "legacy-import@placeholder.local",
        userName: review.userName,
        rating: 5,
        comment: review.comment,
        verifiedPurchase: "false",
        status: "approved",
        productName: productName || product.productTitle || null,
        createdAt,
        modifiedAt: new Date().toISOString(),
      };

      if (DRY_RUN) {
        console.log(`  [DRY] #${review.number} ${review.userName} (${review.rawDate})`);
        console.log(`        PK: ${item.PK}`);
        console.log(`        SK: ${item.SK}`);
        console.log(`        comment: ${review.comment.substring(0, 80)}...`);
      } else {
        try {
          await docClient.send(
            new PutCommand({
              TableName: TABLE_NAME,
              Item: item,
              // No condition — we WANT to overwrite on re-run (idempotent)
            }),
          );
          console.log(`  ✓ #${review.number} ${review.userName}`);
          imported++;
        } catch (err) {
          console.error(`  ✗ #${review.number} ${review.userName}: ${err.message}`);
          failed++;
        }

        // Small delay to avoid throttling
        await sleep(50);
      }
    }
  }

  console.log("\n--- Summary ---");
  if (DRY_RUN) {
    console.log("MODE:               DRY RUN (no writes)");
  }
  console.log(`Imported:           ${imported}`);
  console.log(`Skipped (no map):   ${skippedNoMapping}`);
  console.log(`Skipped (no date):  ${skippedNoDate}`);
  console.log(`Failed:             ${failed}`);

  if (DRY_RUN) {
    console.log("\nTo execute: node scripts/import-legacy-reviews.mjs --execute");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
