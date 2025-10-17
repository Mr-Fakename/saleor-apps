/**
 * Direct test of the OrderFullyPaidUseCase
 * Bypasses webhook authentication to test the core logic
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

// Mock ORDER_FULLY_PAID event payload
const mockPayload = {
  order: {
    id: 'T3JkZXI6MQ==',
    number: 'TEST-001',
    created: new Date().toISOString(),
    user: {
      id: 'VXNlcjox',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'Customer',
    },
    lines: [
      {
        id: 'T3JkZXJMaW5lOjE=',
        productName: 'Tone King Imperial Preamp Manual',
        variantName: 'Digital PDF',
        variant: {
          id: 'UHJvZHVjdFZhcmlhbnQ6MQ==',
          name: 'Digital PDF',
          product: {
            id: 'UHJvZHVjdDox',
            name: 'Tone King Imperial Preamp Manual',
            media: [
              {
                url: 'https://saleor-api.vps.daybreakdevelopment.eu/media/file_upload/TONE-KING-IMPERIAL-PREAMP-INSTRUCTION-MANUAL-BOOKLET-FINAL-02-13-2025.indd_-_TONE-KING-IMPERIAL-PREAMP-INSTRUCTION-MANUAL-BOOKLET_63a6977a.pdf',
                alt: 'Tone King Manual PDF',
                type: 'FILE',
              },
            ],
          },
          media: [],
        },
        totalPrice: {
          gross: {
            amount: 29.99,
            currency: 'USD',
          },
        },
      },
    ],
  },
};

async function testDirectUseCaseCall() {
  console.log('\n🧪 Direct Use Case Test\n');
  console.log('=' .repeat(70), '\n');

  console.log('📦 Test Order:');
  console.log(`   ID: ${mockPayload.order.id}`);
  console.log(`   Number: ${mockPayload.order.number}`);
  console.log(`   Customer: ${mockPayload.order.user.email}`);
  console.log(`   Product: ${mockPayload.order.lines[0].productName}`);
  console.log(`   File URL: ${mockPayload.order.lines[0].variant.product.media[0].url}\n`);

  try {
    // Make direct API call to the use case endpoint
    const response = await fetch('http://localhost:3003/api/test-order-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payload: mockPayload }),
    });

    if (!response.ok) {
      // If direct endpoint doesn't exist, create tokens manually
      console.log('⚠️  Direct endpoint not available, testing DynamoDB directly...\n');
      await testDynamoDBDirectly();
      return;
    }

    const result = await response.json();
    console.log('✅ Use case executed successfully!');
    console.log('Response:', JSON.stringify(result, null, 2), '\n');

  } catch (error) {
    console.log('⚠️  API call failed, testing DynamoDB connection directly...\n');
    await testDynamoDBDirectly();
  }
}

async function testDynamoDBDirectly() {
  console.log('🔧 Testing DynamoDB Connection and Token Creation\n');

  try {
    const client = new DynamoDBClient({
      endpoint: 'http://localhost:8001',
      region: 'localhost',
      credentials: {
        accessKeyId: 'local',
        secretAccessKey: 'local',
      },
    });

    const docClient = DynamoDBDocumentClient.from(client);

    // Create a test token directly
    const crypto = await import('crypto');
    const testToken = crypto.randomBytes(32).toString('hex');
    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + 72);

    const testTokenData = {
      PK: `TOKEN#${testToken}`,
      SK: 'METADATA',
      token: testToken,
      orderId: mockPayload.order.id,
      orderNumber: mockPayload.order.number,
      customerId: mockPayload.order.user.id,
      customerEmail: mockPayload.order.user.email,
      fileUrl: mockPayload.order.lines[0].variant.product.media[0].url,
      productName: mockPayload.order.lines[0].productName,
      variantName: mockPayload.order.lines[0].variantName,
      expiresAt: expiryDate.toISOString(),
      maxDownloads: 5,
      downloadCount: 0,
      createdAt: new Date().toISOString(),
    };

    console.log('💾 Creating test token in DynamoDB...');

    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    await docClient.send(
      new PutCommand({
        TableName: 'digital-downloads-main-table',
        Item: testTokenData,
      })
    );

    console.log('✅ Test token created successfully!\n');

    // Verify it was created
    const result = await docClient.send(
      new ScanCommand({
        TableName: 'digital-downloads-main-table',
        Limit: 10,
      })
    );

    if (result.Items && result.Items.length > 0) {
      console.log(`✅ Found ${result.Items.length} tokens in DynamoDB:\n`);

      result.Items.forEach((item, i) => {
        if (item.token) {
          console.log(`  ${i + 1}. Order: ${item.orderNumber}`);
          console.log(`     Product: ${item.productName}`);
          console.log(`     Customer: ${item.customerEmail}`);
          console.log(`     Token: ${item.token.substring(0, 40)}...`);
          console.log(`     Expires: ${item.expiresAt}`);
          console.log(`     Downloads: ${item.downloadCount}/${item.maxDownloads}`);
          console.log(`     File URL: ${item.fileUrl}`);
          console.log(`     Download Link: http://localhost:3003/api/downloads/${item.token}\n`);
        }
      });

      console.log('🎉 Success! You can now test the download endpoint:');
      console.log(`   http://localhost:3003/api/downloads/${testToken}\n`);

      // Test the download endpoint
      console.log('🔗 Testing download endpoint...\n');
      const downloadResponse = await fetch(`http://localhost:3003/api/downloads/${testToken}`, {
        redirect: 'manual', // Don't follow redirects
      });

      console.log(`   Status: ${downloadResponse.status}`);
      console.log(`   Status Text: ${downloadResponse.statusText}`);

      if (downloadResponse.status === 302 || downloadResponse.status === 307) {
        const location = downloadResponse.headers.get('location');
        console.log(`   ✅ Redirect to: ${location}\n`);
      } else {
        const text = await downloadResponse.text();
        console.log(`   Response: ${text.substring(0, 200)}\n`);
      }

    } else {
      console.log('⚠️  No tokens found in DynamoDB\n');
    }

  } catch (error) {
    console.error('❌ DynamoDB test failed:', error.message);
    console.error(error.stack);
  }
}

// Run test
testDirectUseCaseCall().then(() => {
  console.log('=' .repeat(70));
  console.log('Test completed!\n');
}).catch(console.error);
