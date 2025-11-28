# Webhook Attributes Issue - Diagnostic Report

## Problem Identified

The webhook payload is **NOT including the "Files" attribute** even though it exists on the product/variant.

### Evidence

**Your GraphQL Query Shows:**
```json
{
  "variant": {
    "attributes": [
      {
        "attribute": { "name": "Platform" },
        ...
      },
      {
        "attribute": { "name": "Files" },  // ✅ EXISTS
        "values": [{
          "file": {
            "url": "https://.../SDS_Jpre1_Tonex_V2_premium_tone_models.rar"
          }
        }]
      }
    ]
  }
}
```

**But Webhook Payload Shows:**
```
🔍 DEBUG - Checking 1 variant attributes
🔍 DEBUG - Variant attribute: "Platform", isFile: false
🔍 DEBUG - Checking 1 product attributes
🔍 DEBUG - Product attribute: "Embed", isFile: false
```

The "Files" attribute is **missing** from the webhook! ❌

---

## Root Cause Analysis

There are three possible causes:

### 1. Webhook Subscription Query Issue (Most Likely)

The webhook GraphQL subscription might not be properly configured to fetch file-type attributes. Saleor webhooks can be selective about what data they include.

**Current Webhook Query** (`order-fully-paid.graphql`):
```graphql
variant {
  attributes {
    attribute {
      name
    }
    values {
      name
      file {
        url
        contentType
      }
    }
  }
}
```

This looks correct, but Saleor might be filtering out attributes based on some criteria.

### 2. Saleor Webhook Serialization Bug

Saleor might have a bug where file-type attributes aren't properly serialized in webhook payloads for the `ORDER_FULLY_PAID` event.

### 3. Attribute Visibility Settings

The "Files" attribute might have visibility settings that prevent it from being included in webhooks.

---

## Next Debugging Step

I've added enhanced webhook payload logging to `use-case.ts`. This will show the **COMPLETE** attribute structure from the webhook.

### Deploy and Test

1. **Build the updated app**:
   ```bash
   cd saleor-apps
   pnpm --filter saleor-app-digital-downloads build
   ```

2. **Deploy to your server**

3. **Create a new test order** and mark as paid

4. **Look for this in the logs**:
   ```
   🔍 WEBHOOK DEBUG - Order Line 1:
   Product: SDS Jpre1 Premium Tonex V2 Tone Models
   Variant: V2 Tonex Captures

   📦 VARIANT ATTRIBUTES (full structure):
   [
     {
       "attribute": { "name": "Platform" },
       "values": [...]
     },
     {
       "attribute": { "name": "Files" },  // <-- Is this here?
       "values": [...]
     }
   ]
   ```

5. **Send me the output** - This will definitively show if the attribute is in the webhook payload or not

---

## Potential Solutions

### Solution A: If Attributes ARE in Webhook (But Not Being Detected)

If the full JSON shows "Files" attribute **is** present, then the issue is with our detection logic. We'll fix the `getFileUrls()` function.

### Solution B: If Attributes Are NOT in Webhook (Current Suspicion)

If the full JSON confirms "Files" is **missing**, we have two options:

#### Option B1: Update Webhook Subscription Query

Modify `graphql/subscriptions/order-fully-paid.graphql` to explicitly request file attributes or use a different query structure.

#### Option B2: Fetch Attributes Separately

Instead of relying on the webhook payload, make a separate GraphQL query to fetch the product/variant attributes when processing the order:

```typescript
// In use-case.ts, after receiving webhook:
const productDetails = await graphqlClient.query({
  query: GET_PRODUCT_ATTRIBUTES,
  variables: { productId: line.variant.product.id }
});
```

This would be more reliable but adds an extra API call.

#### Option B3: Use Product Metadata Instead

Store file URLs in product metadata (which IS reliably included in webhooks) instead of attributes:

```json
{
  "product": {
    "metadata": [
      { "key": "download_file_1", "value": "https://.../file1.rar" },
      { "key": "download_file_2", "value": "https://.../file2.rar" }
    ]
  }
}
```

This would require changing your Dashboard workflow.

---

## Recommended Path Forward

1. **Deploy the enhanced debug version** (already done in code)
2. **Test with a new order** to see the full webhook payload
3. **Based on the output**, we'll implement the appropriate fix:
   - If attributes are there → Fix detection logic
   - If attributes are missing → Fetch them separately or use metadata

---

## Files Modified (Latest)

- ✅ `src/app/api/webhooks/saleor/order-fully-paid/use-case.ts` - Added full JSON dump of attributes
- ✅ `src/app/api/webhooks/saleor/order-fully-paid/file-utils.ts` - Added detailed file detection logging

---

## Immediate Action Required

**Please deploy the updated code and send me the full webhook logs** showing:
- The `🔍 WEBHOOK DEBUG` section
- The `📦 VARIANT ATTRIBUTES` JSON
- The `📦 PRODUCT ATTRIBUTES` JSON

This will tell us exactly what data Saleor is sending (or not sending) in the webhook, and we can implement the correct fix.
