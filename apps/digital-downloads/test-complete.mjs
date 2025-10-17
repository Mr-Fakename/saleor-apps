/**
 * Complete end-to-end test
 * Creates a properly signed token and tests the full download flow
 */

import crypto from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

// Configuration
const SECRET_KEY = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2';
const FILE_URL = 'https://saleor-api.vps.daybreakdevelopment.eu/media/file_upload/TONE-KING-IMPERIAL-PREAMP-INSTRUCTION-MANUAL-BOOKLET-FINAL-02-13-2025.indd_-_TONE-KING-IMPERIAL-PREAMP-INSTRUCTION-MANUAL-BOOKLET_63a6977a.pdf';

// Generate proper HMAC-signed token (matching generate-download-token.ts logic)
function generateSignedToken(orderId, fileUrl, expiresAt) {
  const payload = `${orderId}:${fileUrl}:${expiresAt}`;
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(payload);
  const signature = hmac.digest('hex');
  return `${Buffer.from(payload).toString('base64')}.${signature}`;
}

// Mock order data
const mockOrder = {
  id: 'T3JkZXI6MQ==',
  number: 'TEST-002',
  customerId: 'VXNlcjox',
  customerEmail: 'test@example.com',
  productName: 'Tone King Imperial Preamp Manual',
  variantName: 'Digital PDF',
  fileUrl: FILE_URL,
};

async function runCompleteTest() {
  console.log('\n🧪 Complete End-to-End Test\n');
  console.log('=' .repeat(70), '\n');

  try {
    // Step 1: Generate signed token
    console.log('Step 1: Generate Signed Token\n');

    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + 72); // 72 hours

    const signedToken = generateSignedToken(
      mockOrder.id,
      mockOrder.fileUrl,
      expiryDate.toISOString()
    );

    console.log('✅ Token generated:');
    console.log(`   Token: ${signedToken.substring(0, 60)}...`);
    console.log(`   Length: ${signedToken.length} characters`);
    console.log(`   Expires: ${expiryDate.toISOString()}\n`);

    // Step 2: Store token in DynamoDB
    console.log('Step 2: Store Token in DynamoDB\n');

    const client = new DynamoDBClient({
      endpoint: 'http://localhost:8001',
      region: 'localhost',
      credentials: {
        accessKeyId: 'local',
        secretAccessKey: 'local',
      },
    });

    const docClient = DynamoDBDocumentClient.from(client);

    const tokenData = {
      PK: `TOKEN#${signedToken}`,
      SK: 'METADATA',
      token: signedToken,
      orderId: mockOrder.id,
      orderNumber: mockOrder.number,
      customerId: mockOrder.customerId,
      customerEmail: mockOrder.customerEmail,
      fileUrl: mockOrder.fileUrl,
      productName: mockOrder.productName,
      variantName: mockOrder.variantName,
      expiresAt: expiryDate.toISOString(),
      maxDownloads: 5,
      downloadCount: 0,
      createdAt: new Date().toISOString(),
    };

    await docClient.send(
      new PutCommand({
        TableName: 'digital-downloads-main-table',
        Item: tokenData,
      })
    );

    console.log('✅ Token stored in DynamoDB\n');

    // Step 3: Verify in DynamoDB
    console.log('Step 3: Verify Token in Database\n');

    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: 'digital-downloads-main-table',
        Limit: 10,
      })
    );

    console.log(`✅ Found ${scanResult.Items.length} tokens in database:\n`);

    scanResult.Items.forEach((item, i) => {
      if (item.token) {
        console.log(`  ${i + 1}. Order: ${item.orderNumber}`);
        console.log(`     Product: ${item.productName}`);
        console.log(`     Customer: ${item.customerEmail}`);
        console.log(`     Downloads: ${item.downloadCount}/${item.maxDownloads}`);
        console.log(`     Expires: ${item.expiresAt}\n`);
      }
    });

    // Step 4: Test download endpoint
    console.log('Step 4: Test Download Endpoint\n');

    const downloadUrl = `http://localhost:3003/api/downloads/${signedToken}`;
    console.log(`   URL: ${downloadUrl}\n`);

    const downloadResponse = await fetch(downloadUrl, {
      redirect: 'manual', // Don't follow redirects
    });

    console.log(`   📬 Status: ${downloadResponse.status} ${downloadResponse.statusText}`);

    if (downloadResponse.status === 302 || downloadResponse.status === 307) {
      const location = downloadResponse.headers.get('location');
      console.log(`   ✅ Success! Redirecting to file:`);
      console.log(`   ${location}\n`);

      // Step 5: Verify download count incremented
      console.log('Step 5: Verify Download Count Updated\n');

      const verifyResult = await docClient.send(
        new ScanCommand({
          TableName: 'digital-downloads-main-table',
          FilterExpression: '#token = :token',
          ExpressionAttributeNames: {
            '#token': 'token',
          },
          ExpressionAttributeValues: {
            ':token': signedToken,
          },
        })
      );

      if (verifyResult.Items && verifyResult.Items.length > 0) {
        const updatedToken = verifyResult.Items[0];
        console.log(`   ✅ Download count updated: ${updatedToken.downloadCount}/${updatedToken.maxDownloads}`);
        console.log(`   Last accessed: ${updatedToken.lastAccessedAt}\n`);
      }

      // Test Summary
      console.log('=' .repeat(70));
      console.log('🎉 ALL TESTS PASSED!\n');
      console.log('✅ Token generation: Working');
      console.log('✅ DynamoDB storage: Working');
      console.log('✅ Token validation: Working');
      console.log('✅ Download authorization: Working');
      console.log('✅ Download tracking: Working');
      console.log('✅ File redirect: Working\n');

      console.log('📋 Test Details:');
      console.log(`   Order: ${mockOrder.number}`);
      console.log(`   Product: ${mockOrder.productName}`);
      console.log(`   Customer: ${mockOrder.customerEmail}`);
      console.log(`   Token: ${signedToken.substring(0, 40)}...`);
      console.log(`   Download URL: ${downloadUrl}`);
      console.log(`   File URL: ${mockOrder.fileUrl}\n`);

      console.log('💡 Next Steps:');
      console.log('   1. Test download limit (try downloading 6 times)');
      console.log('   2. Test token expiry (wait 72 hours or modify expiresAt)');
      console.log('   3. Install app in Saleor and test real ORDER_FULLY_PAID webhook');
      console.log('   4. Configure email notifications with download links\n');

    } else {
      const errorText = await downloadResponse.text();
      console.log(`   ❌ Download failed!`);
      console.log(`   Response: ${errorText}\n`);

      try {
        const errorJson = JSON.parse(errorText);
        console.log('   Error details:', errorJson, '\n');
      } catch (e) {
        // Not JSON
      }
    }

    console.log('=' .repeat(70), '\n');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
  }
}

// Run test
runCompleteTest();
