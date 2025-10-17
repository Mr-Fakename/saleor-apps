/**
 * Test script to simulate ORDER_FULLY_PAID webhook
 * This sends a webhook directly to the digital downloads app
 */

const SALEOR_API_URL = "http://localhost:8000/graphql/";
const APP_WEBHOOK_URL = "http://localhost:3003/api/webhooks/saleor/order-fully-paid";

// Mock ORDER_FULLY_PAID webhook payload
const createMockWebhookPayload = (order) => {
  return {
    event: {
      __typename: "OrderFullyPaid",
      issuedAt: new Date().toISOString(),
      version: "3.21",
      issuingPrincipal: null,
      recipient: {
        id: "QXBwOjE=",
      },
      order: {
        id: order.id,
        number: order.number,
        created: order.created,
        user: order.user || {
          id: "VXNlcjox",
          email: "customer@example.com",
          firstName: "Test",
          lastName: "Customer",
        },
        lines: order.lines.map((line) => ({
          id: line.id,
          productName: line.productName,
          variantName: line.variantName,
          variant: {
            id: line.variant?.id || "UHJvZHVjdFZhcmlhbnQ6MQ==",
            name: line.variant?.name || line.variantName,
            product: {
              id: "UHJvZHVjdDox",
              name: line.productName,
              media: line.variant?.product?.media || [
                {
                  url: "https://saleor-api.vps.daybreakdevelopment.eu/media/file_upload/TONE-KING-IMPERIAL-PREAMP-INSTRUCTION-MANUAL-BOOKLET-FINAL-02-13-2025.indd_-_TONE-KING-IMPERIAL-PREAMP-INSTRUCTION-MANUAL-BOOKLET_63a6977a.pdf",
                  alt: "Digital Product File",
                  type: "FILE",
                },
              ],
            },
            media: line.variant?.media || [],
          },
          totalPrice: {
            gross: {
              amount: line.totalPrice?.gross?.amount || 99.99,
              currency: line.totalPrice?.gross?.currency || "USD",
            },
          },
        })),
      },
    },
  };
};

// Fetch orders from Saleor
async function fetchOrders() {
  console.log("📡 Fetching orders from Saleor...\n");

  const query = `
    query GetOrders {
      orders(first: 5) {
        edges {
          node {
            id
            number
            created
            user {
              id
              email
              firstName
              lastName
            }
            lines {
              id
              productName
              variantName
              variant {
                id
                name
                product {
                  id
                  name
                  media {
                    url
                    alt
                    type
                  }
                }
                media {
                  url
                  alt
                  type
                }
              }
              totalPrice {
                gross {
                  amount
                  currency
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch(SALEOR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const data = await response.json();

  if (data.errors) {
    console.error("❌ GraphQL Errors:", data.errors);
    throw new Error("Failed to fetch orders");
  }

  return data.data.orders.edges.map((edge) => edge.node);
}

// Send webhook to app
async function sendWebhook(payload) {
  console.log("🚀 Sending ORDER_FULLY_PAID webhook to app...\n");
  console.log("Payload:", JSON.stringify(payload, null, 2), "\n");

  const response = await fetch(APP_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "saleor-domain": "localhost:8000",
      "saleor-event": "order_fully_paid",
      "saleor-signature": "test-signature", // In production, this would be a real JWT signature
    },
    body: JSON.stringify(payload),
  });

  console.log("📬 Response Status:", response.status);

  const responseText = await response.text();
  console.log("📬 Response Body:", responseText, "\n");

  return {
    status: response.status,
    body: responseText,
  };
}

// Main test function
async function testWebhook() {
  try {
    console.log("🧪 Starting Digital Downloads Webhook Test\n");
    console.log("=".repeat(60), "\n");

    // Fetch orders
    const orders = await fetchOrders();

    if (orders.length === 0) {
      console.log("❌ No orders found in Saleor");
      console.log("💡 Please create an order in the Saleor dashboard first\n");
      return;
    }

    console.log(`✅ Found ${orders.length} orders\n`);

    // Use the first order for testing
    const order = orders[0];
    console.log(
      "📦 Testing with order:",
      {
        id: order.id,
        number: order.number,
        lines: order.lines.length,
      },
      "\n",
    );

    // Check if order has any files
    const hasFiles = order.lines.some(
      (line) => line.variant?.media?.length > 0 || line.variant?.product?.media?.length > 0,
    );

    if (!hasFiles) {
      console.log("⚠️  Order has no digital files (no media attached)");
      console.log("💡 Adding a mock file URL to test the flow...\n");
    }

    // Create webhook payload
    const webhookPayload = createMockWebhookPayload(order);

    // Send webhook
    const result = await sendWebhook(webhookPayload);

    if (result.status === 200) {
      console.log("✅ Webhook processed successfully!\n");
      console.log("=".repeat(60));
      console.log("🎉 Test completed! Check the app logs for token generation.");
      console.log("=".repeat(60), "\n");
    } else {
      console.log(`❌ Webhook failed with status ${result.status}\n`);
      console.log("Response:", result.body, "\n");
    }
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    console.error(error.stack);
  }
}

// Run the test
testWebhook();
