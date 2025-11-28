# Debug Deployment Guide

## Changes Made

Added comprehensive debug logging to `file-utils.ts` to diagnose why files aren't being detected.

### Debug Output Will Show

When a webhook is received, you'll see console logs like:

```
🔍 DEBUG - getFileUrls called with line: {
  "productName": "SDS Impulse Response MEGA bundle",
  "variantName": "...",
  "hasVariant": true,
  "hasProduct": true,
  "variantAttributesCount": 3,
  "productAttributesCount": 3
}

🔍 DEBUG - Checking 3 variant attributes
🔍 DEBUG - Variant attribute: "Files", isFile: true, valuesCount: 1
🔍 DEBUG - Variant value: {
  "name": "SDS_FF70.rar",
  "hasFile": true,
  "fileUrl": "https://..."
}

🔍 DEBUG - Checking 3 product attributes
🔍 DEBUG - Product attribute: "Files", isFile: true, valuesCount: 1
...

🔍 DEBUG - getFileUrls returning 2 files: [...]
```

## Deployment Steps

### Option 1: Build from Root (Recommended)

```bash
cd C:/Users/G533/WebstormProjects/e-commerce-template/saleor-apps
pnpm install
pnpm --filter saleor-app-digital-downloads build
```

### Option 2: Build from IDE

1. Open the project in your IDE (WebStorm/VS Code)
2. Right-click on `saleor-apps/apps/digital-downloads`
3. Run the build task

### Option 3: Build with Next.js CLI (if available)

```bash
cd saleor-apps/apps/digital-downloads
npx next build
```

### After Building

1. **Deploy** the built app to your server
2. **Create a test order** with one of your digital products
3. **Mark it as paid** to trigger the webhook
4. **Check the logs** for the debug output

## What to Look For in Logs

### Scenario 1: Attributes Not Coming Through
```
🔍 DEBUG - getFileUrls called with line: {
  "variantAttributesCount": 0,
  "productAttributesCount": 0
}
```
**Issue**: Webhook query isn't fetching attributes
**Fix**: Need to update the webhook GraphQL query

### Scenario 2: Attributes Present But No Files
```
🔍 DEBUG - Product attribute: "Files", isFile: true, valuesCount: 1
🔍 DEBUG - Product value: {
  "name": "SDS_FF70.rar",
  "hasFile": false,
  "fileUrl": undefined
}
```
**Issue**: File attribute has values but no file URL
**Fix**: Need to check Dashboard - file may not be uploaded

### Scenario 3: File Object Is Null
```
🔍 DEBUG - Product value: {
  "name": "SDS_FF70.rar",
  "hasFile": false,
  "fileUrl": undefined
}
```
**Issue**: `value.file` is null
**Fix**: This means the attribute value isn't a file type, or the webhook query isn't fetching the `file` field

### Scenario 4: Working Correctly
```
🔍 DEBUG - Product value: {
  "name": "SDS_FF70.rar",
  "hasFile": true,
  "fileUrl": "https://saleor-api.sonicdrivestudio.com/media/file_upload/SDS_FF70.rar"
}
🔍 DEBUG - getFileUrls returning 2 files: [...]
```
**Success**: Files detected correctly!

## Likely Issue

Based on your error "No file URLs found", the most likely causes are:

1. **Webhook query not fetching attributes correctly** - Attributes might be null/empty in the webhook payload
2. **Product attributes not at expected path** - Data structure might be different than expected
3. **File object is null** - The `file` field in the attribute value might not be populated

## Next Steps After Deploying

1. Deploy the updated code
2. Trigger a test webhook (create and pay for an order)
3. Send me the complete debug output from the logs
4. I'll analyze it and implement the fix

## Files Modified

- ✅ `src/app/api/webhooks/saleor/order-fully-paid/file-utils.ts` - Added debug logging

No other changes needed for debugging. The fix will depend on what the debug output shows.
