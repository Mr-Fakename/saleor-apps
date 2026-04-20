/* eslint-disable no-console */
import { writeFileSync } from "node:fs";

/**
 * Customer Extensions app doesn't use webhooks yet.
 * This script is a placeholder for future webhook type generation.
 */
async function generateAppWebhooksTypes() {
  // Create a placeholder file
  writeFileSync(
    "./generated/app-webhooks-types/index.ts",
    "// No webhook types generated yet\nexport {};\n"
  );
}

try {
  console.log("No webhooks configured for Customer Extensions app");
  await generateAppWebhooksTypes();
  console.log("Webhook types generation complete");
} catch (error) {
  console.error(`Error generating webhook types: ${error}`);
  process.exit(1);
}
