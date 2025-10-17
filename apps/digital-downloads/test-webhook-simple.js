/**
 * Simple test script to simulate ORDER_FULLY_PAID webhook
 * Uses a mock order with your actual file URL
 */

const APP_WEBHOOK_URL = "http://localhost:3003/api/webhooks/saleor/order-fully-paid";

// Mock ORDER_FULLY_PAID webhook payload with your actual file URL
const mockWebhookPayload = {
  event: {
    __typename: "OrderFullyPaid",
    issuedAt: new Date().toISOString(),
    version: "3.21",
    issuingPrincipal: null,
    recipient: {
      id: "QXBwOjE=",
    },
    order: {
      id: "T3JkZXI6MQ==",
      number: "TEST-001",
      created: new Date().toISOString(),
      user: {
        id: "VXNlcjox",
        email: "test@example.com",
        firstName: "Test",
        lastName: "Customer",
      },
      lines: [
        {
          id: "T3JkZXJMaW5lOjE=",
          productName: "Tone King Imperial Preamp Manual",
          variantName: "Digital PDF",
          variant: {
            id: "UHJvZHVjdFZhcmlhbnQ6MQ==",
            name: "Digital PDF",
            product: {
              id: "UHJvZHVjdDox",
              name: "Tone King Imperial Preamp Manual",
              media: [
                {
                  url: "https://saleor-api.vps.daybreakdevelopment.eu/media/file_upload/TONE-KING-IMPERIAL-PREAMP-INSTRUCTION-MANUAL-BOOKLET-FINAL-02-13-2025.indd_-_TONE-KING-IMPERIAL-PREAMP-INSTRUCTION-MANUAL-BOOKLET_63a6977a.pdf",
                  alt: "Tone King Manual PDF",
                  type: "FILE",
                },
              ],
            },
            media: [],
          },
          totalPrice: {
            gross: {
              amount: 29.99,
              currency: "USD",
            },
          },
        },
      ],
    },
  },
};

// Send webhook to app
async function sendWebhook(payload) {
  console.log("🚀 Sending ORDER_FULLY_PAID webhook to app...\n");
  console.log("📦 Order ID:", payload.event.order.id);
  console.log("📦 Order Number:", payload.event.order.number);
  console.log("📦 Product:", payload.event.order.lines[0].productName);
  console.log("📦 File URL:", payload.event.order.lines[0].variant.product.media[0].url, "\n");

  try {
    const response = await fetch(APP_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "saleor-api-url": "http://localhost:8000/graphql/",
        "saleor-domain": "localhost:8000",
        "saleor-event": "order_fully_paid",
        "saleor-signature": "mock-signature-for-testing",
      },
      body: JSON.stringify(payload),
    });

    console.log("📬 Response Status:", response.status);

    const responseText = await response.text();
    console.log("📬 Response Body:", responseText, "\n");

    if (response.status === 200) {
      console.log("✅ Webhook processed successfully!\n");
      console.log("=".repeat(70));
      console.log("🎉 Success! Download tokens should be created in DynamoDB");
      console.log("=".repeat(70), "\n");

      // Try to parse response to show tokens
      try {
        const result = JSON.parse(responseText);
        if (result.tokens) {
          console.log("🔑 Generated Tokens:");
          result.tokens.forEach((token, i) => {
            console.log(`\n  Token ${i + 1}:`);
            console.log(`    Product: ${token.productName}`);
            console.log(`    Token: ${token.token}`);
            console.log(`    Expires: ${token.expiresAt}`);
            console.log(`    Max Downloads: ${token.maxDownloads}`);
            console.log(`    Download URL: http://localhost:3003/api/downloads/${token.token}`);
          });
          console.log();
        }
      } catch (e) {
        // Response might not be JSON, that's okay
      }

      console.log("💡 Next steps:");
      console.log("  1. Check app logs for token generation details");
      console.log("  2. Test download URL (shown above if tokens were returned)");
      console.log("  3. Verify tokens in DynamoDB\n");

      return true;
    } else {
      console.log(`❌ Webhook failed with status ${response.status}\n`);
      console.log("Response:", responseText, "\n");
      return false;
    }
  } catch (error) {
    console.error("❌ Request failed:", error.message);
    return false;
  }
}

// Test DynamoDB by listing tokens
async function checkDynamoDB() {
  console.log("🔍 Checking DynamoDB for tokens...\n");

  try {
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient, ScanCommand } = await import("@aws-sdk/lib-dynamodb");

    const client = new DynamoDBClient({
      endpoint: "http://localhost:8001",
      region: "localhost",
      credentials: {
        accessKeyId: "local",
        secretAccessKey: "local",
      },
    });

    const docClient = DynamoDBDocumentClient.from(client);

    const result = await docClient.send(
      new ScanCommand({
        TableName: "digital-downloads-main-table",
        Limit: 10,
      }),
    );

    if (result.Items && result.Items.length > 0) {
      console.log(`✅ Found ${result.Items.length} items in DynamoDB:\n`);

      result.Items.forEach((item, i) => {
        if (item.token) {
          console.log(`  ${i + 1}. Token: ${item.token.substring(0, 50)}...`);
          console.log(`     Order: ${item.orderNumber} (${item.orderId})`);
          console.log(`     Product: ${item.productName}`);
          console.log(`     Expires: ${item.expiresAt}`);
          console.log(`     Downloads: ${item.downloadCount}/${item.maxDownloads}\n`);
        }
      });
    } else {
      console.log("⚠️  No tokens found in DynamoDB yet\n");
    }
  } catch (error) {
    console.error("❌ Failed to check DynamoDB:", error.message);
  }
}

// Main test function
async function runTest() {
  console.log("\n🧪 Digital Downloads Webhook Test\n");
  console.log("=".repeat(70), "\n");

  // Send webhook
  const success = await sendWebhook(mockWebhookPayload);

  if (success) {
    // Wait a moment for processing
    console.log("⏳ Waiting 2 seconds for processing...\n");
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check DynamoDB
    await checkDynamoDB();
  }

  console.log("=".repeat(70));
  console.log("Test completed!\n");
}

// Run the test
runTest().catch(console.error);
