# Quick Fix - Deploy Working Version with Debug Logging

## The Issue

The "Files" attribute is not appearing in the webhook payload, even though it exists on the product.

## Immediate Solution

Since we're having build issues with the automated scripts, here's the manual fix:

### Step 1: Add Webhook Payload Logging

Edit `src/app/api/webhooks/saleor/order-fully-paid/use-case.ts`

After line 100 (`order.lines.forEach((line, index) => {`), add these lines:

```typescript
        console.log("=" + "=".repeat(79));
        console.log(`WEBHOOK DEBUG - Order Line ${index + 1}`);
        console.log("Product:", line.productName);
        console.log("Variant:", line.variantName);
        console.log("VARIANT ATTRIBUTES:");
        console.log(JSON.stringify(line.variant?.attributes, null, 2));
        console.log("PRODUCT ATTRIBUTES:");
        console.log(JSON.stringify(line.variant?.product?.attributes, null, 2));
        console.log("=" + "=".repeat(79));
```

This will show us the EXACT data Saleor is sending in the webhook.

### Step 2: Test

1. Build and deploy
2. Create a test order
3. Send me the webhook logs showing the JSON output

### What We'll See

If the "Files" attribute IS in the JSON → We'll fix the detection logic
If the "Files" attribute is NOT in the JSON → We need to fetch it separately

## Alternative: Fetch Attributes Separately

If the webhook doesn't include "Files", we can add this in the use-case:

```typescript
// Import at top
import { getSaleorClient } from "@/lib/graphql-client";

// In the loop, before getFileUrls:
const client = getSaleorClient();
const { data } = await client.query({
  query: gql`
    query GetVariantFiles($variantId: ID!) {
      productVariant(id: $variantId) {
        attributes {
          attribute { name }
          values {
            name
            file { url contentType }
          }
        }
      }
    }
  `,
  variables: { variantId: line.variant.id }
});

// Use data.productVariant.attributes instead of line.variant.attributes
```

This guarantees we get the file attributes regardless of what's in the webhook.

## Files Already Working

- `file-utils.ts` - Has debug logging and multi-file support ✅
- Domain models - Have file grouping fields ✅
- Email template - Shows "Part X of Y" ✅

We just need to either:
1. Fix why webhook doesn't include "Files" attribute, OR
2. Fetch the attributes separately via GraphQL

Send me the webhook debug output and I'll implement the exact fix!
