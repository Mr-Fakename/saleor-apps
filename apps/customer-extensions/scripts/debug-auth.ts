/**
 * Debug script to check APL (Auth Persistence Layer) status
 *
 * This script helps diagnose JWT verification issues by:
 * 1. Checking if the app is registered in the APL
 * 2. Verifying the app ID matches the manifest
 * 3. Testing JWT verification with a sample token
 *
 * Usage: pnpm tsx scripts/debug-auth.ts
 */

import { saleorApp } from "../src/lib/saleor-app";
import { env } from "../src/lib/env";

async function debugAuth() {
  console.log("=== Customer Extensions App - Auth Debug ===\n");

  // 1. Check manifest app ID
  console.log("1. Manifest Configuration:");
  console.log(`   App ID: ${env.MANIFEST_APP_ID}`);
  console.log(`   App Name: ${env.APP_NAME}`);
  console.log(`   APL Type: ${env.APL}\n`);

  // 2. Check if APL has any auth data
  console.log("2. Checking APL for registered installations:");

  try {
    const allAuthData = await saleorApp.apl.getAll();

    if (allAuthData.length === 0) {
      console.log("   ⚠️  WARNING: No app installations found in APL!");
      console.log("   This means the app is not installed in any Saleor instance.");
      console.log("\n   To fix this:");
      console.log("   1. Go to your Saleor Dashboard");
      console.log("   2. Navigate to Apps → Install External App");
      console.log("   3. Enter the app's manifest URL");
      console.log("   4. Complete the installation");
      return;
    }

    console.log(`   ✓ Found ${allAuthData.length} installation(s):\n`);

    for (const authData of allAuthData) {
      console.log(`   Saleor API URL: ${authData.saleorApiUrl}`);
      console.log(`   App ID: ${authData.appId}`);
      console.log(`   App Token: ${authData.token.substring(0, 20)}...`);

      // Check if app ID matches manifest
      if (authData.appId !== env.MANIFEST_APP_ID) {
        console.log(`   ⚠️  WARNING: App ID mismatch!`);
        console.log(`      - Expected: ${env.MANIFEST_APP_ID}`);
        console.log(`      - Found: ${authData.appId}`);
        console.log(`      This will cause JWT verification to fail.`);
        console.log(`      Solution: Reinstall the app in Saleor.\n`);
      } else {
        console.log(`   ✓ App ID matches manifest\n`);
      }
    }
  } catch (error) {
    console.error("   ❌ Error reading from APL:", error);
    console.log("\n   Possible causes:");
    console.log("   - APL configuration is incorrect");
    console.log("   - Database/file is not accessible");
    console.log("   - DynamoDB table does not exist");
  }

  // 3. Test specific Saleor API URL
  console.log("\n3. Testing specific Saleor instance:");
  const testSaleorUrl = process.argv[2] || "https://saleor-api.vps.daybreakdevelopment.eu/graphql/";
  console.log(`   Saleor API URL: ${testSaleorUrl}`);

  try {
    const authData = await saleorApp.apl.get(testSaleorUrl);

    if (!authData) {
      console.log("   ❌ No auth data found for this Saleor instance");
      console.log("\n   This is the root cause of JWT verification failures.");
      console.log("   The app needs to be installed in Saleor at this URL.\n");
      return;
    }

    console.log("   ✓ Auth data found!");
    console.log(`   App ID: ${authData.appId}`);
    console.log(`   Token: ${authData.token.substring(0, 20)}...\n`);

    if (authData.appId !== env.MANIFEST_APP_ID) {
      console.log("   ⚠️  WARNING: App ID mismatch will cause JWT verification to fail");
    }
  } catch (error) {
    console.error("   ❌ Error:", error);
  }

  console.log("\n=== Debug Complete ===");
  console.log("\nNext steps:");
  console.log("1. If no installations found: Install the app in Saleor Dashboard");
  console.log("2. If app ID mismatch: Reinstall the app (it will get the correct ID)");
  console.log("3. If auth data missing for your URL: Install app for that Saleor instance");
  console.log("4. Check the enhanced logs when making tRPC requests for more details");
}

debugAuth().catch(console.error);
