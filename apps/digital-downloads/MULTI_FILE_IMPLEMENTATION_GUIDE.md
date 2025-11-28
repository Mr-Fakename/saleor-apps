# Multi-File Download Support - Implementation Guide

This guide provides step-by-step instructions to implement support for multiple downloadable files per product (e.g., "Files" and "Files Part 2" attributes).

## Overview

**Problem:** The current implementation only processes the FIRST file found per product, ignoring additional file attributes.

**Solution:** Implement Option 3 (Hybrid Approach) - Create one token per file with grouping metadata to show "Part X of Y" in emails and logs.

---

## Changes Required

### 1. Create File Utils Module

**File:** `src/app/api/webhooks/saleor/order-fully-paid/file-utils.ts` (NEW FILE)

```typescript
/**
 * File metadata for download tokens
 */
export interface FileMetadata {
  url: string;
  name: string;
  attributeName: string;
}

/**
 * Extracts ALL file URLs from a line item
 *
 * Looks for attributes with file-related names (Files, File, Download, etc.)
 * Collects files from ALL matching attributes and all values within those attributes
 * Priority: variant attributes > product attributes
 * Note: Media fallback removed to prevent product images from being treated as downloads
 */
export function getFileUrls(line: any): FileMetadata[] {
  const fileMetadataList: FileMetadata[] = [];

  // File-related attribute names to look for (case-insensitive)
  const fileAttributeNames = [
    "file",
    "files",
    "download",
    "downloads",
    "attachment",
    "attachments",
  ];

  /**
   * Helper to check if an attribute name matches file-related patterns
   */
  const isFileAttribute = (attributeName: string): boolean => {
    const lowerName = attributeName.toLowerCase();
    return fileAttributeNames.some((pattern) => lowerName.includes(pattern));
  };

  // Collect ALL variant file attributes
  const variantAttributes = line?.variant?.attributes || [];
  for (const attr of variantAttributes) {
    const attributeName = attr?.attribute?.name || "";

    // Only check attributes with file-related names
    if (isFileAttribute(attributeName)) {
      const values = attr?.values || [];
      for (const value of values) {
        if (value?.file?.url) {
          fileMetadataList.push({
            url: value.file.url,
            name: value.name || value.file.url.split("/").pop() || "download",
            attributeName: attributeName,
          });
        }
      }
    }
  }

  // Collect ALL product file attributes
  const productAttributes = line?.variant?.product?.attributes || [];
  for (const attr of productAttributes) {
    const attributeName = attr?.attribute?.name || "";

    // Only check attributes with file-related names
    if (isFileAttribute(attributeName)) {
      const values = attr?.values || [];
      for (const value of values) {
        if (value?.file?.url) {
          fileMetadataList.push({
            url: value.file.url,
            name: value.name || value.file.url.split("/").pop() || "download",
            attributeName: attributeName,
          });
        }
      }
    }
  }

  // No media fallback - only return actual file attributes
  // This prevents product images from being treated as downloads

  return fileMetadataList;
}
```

---

### 2. Update Domain Model

**File:** `src/modules/download-tokens/domain/download-token.ts`

**Change the downloadTokenSchema** to add file grouping fields:

```typescript
export const downloadTokenSchema = z.object({
  token: z.string().brand("DownloadToken"),
  orderId: z.string(),
  orderNumber: z.string(),
  customerId: z.string().optional(),
  customerEmail: z.string().email().optional(),
  fileUrl: z.string().url(),
  productName: z.string(),
  variantName: z.string().optional(),
  expiresAt: z.string().datetime(),
  maxDownloads: z.number().int().positive(),
  downloadCount: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  lastAccessedAt: z.string().datetime().optional(),
  // File grouping metadata (for multi-file products)
  fileGroup: z.string().optional(),
  fileIndex: z.number().int().positive().optional(),
  totalFiles: z.number().int().positive().optional(),
  fileName: z.string().optional(),
});
```

---

### 3. Update Database Model

**File:** `src/modules/download-tokens/repositories/dynamodb/download-token-db-model.ts`

**Add fields to the DownloadTokenDbModel interface:**

```typescript
export interface DownloadTokenDbModel {
  PK: string;
  SK: string;
  token: string;
  orderId: string;
  orderNumber: string;
  customerId?: string;
  customerEmail?: string;
  fileUrl: string;
  productName: string;
  variantName?: string;
  expiresAt: string;
  maxDownloads: number;
  downloadCount: number;
  createdAt: string;
  lastAccessedAt?: string;
  // File grouping metadata (NEW)
  fileGroup?: string;
  fileIndex?: number;
  totalFiles?: number;
  fileName?: string;
}
```

---

### 4. Update Use Case

**File:** `src/app/api/webhooks/saleor/order-fully-paid/use-case.ts`

#### 4a. Add Import

Add this import at the top of the file (after the existing imports):

```typescript
import { getFileUrls, type FileMetadata } from "./file-utils";
```

#### 4b. Remove Old `getFileUrl` Function

**Delete lines 65-135** (the entire `getFileUrl` function and its JSDoc comment).

#### 4c. Replace Token Creation Loop

**Replace the loop starting at line 218** (after line numbers shift from deletions):

**OLD CODE (lines ~148-222 after deletions):**
```typescript
for (const line of digitalLines) {
  const fileUrl = getFileUrl(line);

  if (!fileUrl) {
    logger.warn("No file URL found for digital line", {
      orderId: order.id,
      lineId: line.id,
    });
    continue;
  }

  // ... rest of single-file token creation
}
```

**NEW CODE:**
```typescript
for (const line of digitalLines) {
  const fileMetadataList = getFileUrls(line);

  if (fileMetadataList.length === 0) {
    logger.warn("No file URLs found for digital line", {
      orderId: order.id,
      lineId: line.id,
      productName: line.productName,
    });
    continue;
  }

  logger.info("Found files for digital product", {
    orderId: order.id,
    productName: line.productName,
    fileCount: fileMetadataList.length,
    files: fileMetadataList.map((f) => ({ name: f.name, attribute: f.attributeName })),
  });

  // Create ONE token per file
  const totalFiles = fileMetadataList.length;
  const fileGroup = `${line.variant?.product?.id || line.productName}-files`;

  for (let fileIndex = 0; fileIndex < fileMetadataList.length; fileIndex++) {
    const fileMeta = fileMetadataList[fileIndex];
    const fileUrl = fileMeta.url;

    // Generate the token signature
    const tokenString = generateDownloadToken({
      orderId: order.id,
      fileUrl: fileUrl,
      expiresAt: expiryDate.toISOString(),
    });

    // Create the download token entity with file grouping metadata
    const downloadToken = createDownloadToken({
      token: tokenString as DownloadToken["token"],
      orderId: order.id,
      orderNumber: order.number,
      customerId: order.user?.id,
      customerEmail: order.user?.email || order.userEmail || undefined,
      fileUrl: fileUrl,
      productName: line.productName,
      variantName: line.variantName || undefined,
      expiresAt: expiryDate.toISOString(),
      maxDownloads: env.MAX_DOWNLOAD_LIMIT,
      // File grouping metadata
      fileGroup: fileGroup,
      fileIndex: fileIndex + 1, // 1-indexed for display
      totalFiles: totalFiles,
      fileName: fileMeta.name,
    });

    // Save to repository
    const saveResult = await this.downloadTokenRepo.save(downloadToken);

    if (saveResult.isErr()) {
      logger.error("Failed to save download token", {
        orderId: order.id,
        lineId: line.id,
        fileUrl: fileUrl,
        error: saveResult.error,
      });
      continue;
    }

    tokens.push(downloadToken);

    // Construct the download URL for testing
    const downloadUrl = `${env.APP_API_BASE_URL}/api/downloads/${tokenString}`;

    logger.info("Download token created successfully", {
      orderId: order.id,
      lineId: line.id,
      fileIndex: fileIndex + 1,
      totalFiles: totalFiles,
      token: tokenString,
      downloadUrl: downloadUrl,
    });

    // Log download URL to console for easy testing
    const displayEmail = order.user?.email || order.userEmail || "Guest";
    const partInfo = totalFiles > 1 ? ` (Part ${fileIndex + 1} of ${totalFiles})` : "";
    console.log("\n╔═══════════════════════════════════════════════════════════════════");
    console.log("║ 🔗 DOWNLOAD LINK CREATED");
    console.log("╠═══════════════════════════════════════════════════════════════════");
    console.log(`║ Product: ${line.productName}${partInfo}`);
    if (line.variantName) {
      console.log(`║ Variant: ${line.variantName}`);
    }
    if (totalFiles > 1) {
      console.log(`║ File: ${fileMeta.name}`);
      console.log(`║ Attribute: ${fileMeta.attributeName}`);
    }
    console.log(`║ Order: ${order.number}`);
    console.log(`║ Customer: ${displayEmail}`);
    console.log("╠═══════════════════════════════════════════════════════════════════");
    console.log(`║ 📥 Download URL:`);
    console.log(`║ ${downloadUrl}`);
    console.log("╠═══════════════════════════════════════════════════════════════════");
    console.log(`║ Valid until: ${expiryDate.toISOString()}`);
    console.log(`║ Max downloads: ${env.MAX_DOWNLOAD_LIMIT}`);
    console.log("╚═══════════════════════════════════════════════════════════════════\n");
  }
}
```

---

### 5. Update Email Template

**File:** `src/modules/email/order-confirmation-template.ts`

#### 5a. Update HTML Email Template

**Find the download-item rendering** (around line 195-220) and **replace** with:

```typescript
${downloadTokens
  .map((token) => {
    const partInfo =
      token.totalFiles && token.totalFiles > 1 && token.fileIndex
        ? ` - Part ${token.fileIndex} of ${token.totalFiles}`
        : "";
    const fileName =
      token.fileName && token.totalFiles && token.totalFiles > 1 ? `<br/><small style="color: #6b7280;">File: ${token.fileName}</small>` : "";

    return `
      <div class="download-item">
          <div class="product-name">${token.productName}${partInfo}</div>
          ${
            token.variantName
              ? `<div class="variant-name">${token.variantName}</div>`
              : ""
          }
          ${fileName}
          <a href="${appBaseUrl}/api/downloads/${token.token}" class="download-button">
              Download Now
          </a>
          <div class="expiry-info">
              Valid until ${new Date(token.expiresAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })} • Maximum ${token.maxDownloads} downloads
          </div>
      </div>
    `;
  })
  .join("")}
```

#### 5b. Update Plain Text Email Template

**Find the plain text token rendering** (around line 258-275) and **replace** with:

```typescript
${downloadTokens
  .map((token, index) => {
    const partInfo =
      token.totalFiles && token.totalFiles > 1 && token.fileIndex
        ? ` (Part ${token.fileIndex} of ${token.totalFiles})`
        : "";
    const fileName =
      token.fileName && token.totalFiles && token.totalFiles > 1 ? `\n   File: ${token.fileName}` : "";

    return `
${index + 1}. ${token.productName}${partInfo}${
      token.variantName ? ` - ${token.variantName}` : ""
    }${fileName}

   Download Link:
   ${appBaseUrl}/api/downloads/${token.token}

   Valid until: ${new Date(token.expiresAt).toLocaleDateString("en-US", {
     year: "numeric",
     month: "long",
     day: "numeric",
     hour: "2-digit",
     minute: "2-digit",
   })}
   Maximum downloads: ${token.maxDownloads}
`;
  })
  .join("\n")}
```

---

## Testing

### 1. Type Check

```bash
cd saleor-apps/apps/digital-downloads
pnpm exec tsc --noEmit
```

### 2. Build

```bash
pnpm build
```

### 3. Test with Example Product

Create a test order with your "SDS Impulse Response MEGA bundle" product that has:
- "Files" attribute with one file
- "Files Part 2" attribute with another file

#### Expected Results:

**Console Output:**
```
╔═══════════════════════════════════════════════════════════════════
║ 🔗 DOWNLOAD LINK CREATED
╠═══════════════════════════════════════════════════════════════════
║ Product: SDS Impulse Response MEGA bundle (Part 1 of 2)
║ File: gi_001-im-1920x1080_3ddbae62.jpg
║ Attribute: Files
║ Order: 12345
║ Customer: customer@example.com
╠═══════════════════════════════════════════════════════════════════
║ 📥 Download URL:
║ https://your-app.com/api/downloads/TOKEN1
╠═══════════════════════════════════════════════════════════════════

╔═══════════════════════════════════════════════════════════════════
║ 🔗 DOWNLOAD LINK CREATED
╠═══════════════════════════════════════════════════════════════════
║ Product: SDS Impulse Response MEGA bundle (Part 2 of 2)
║ File: gi_200-im-1920x1080_2cb450ed.jpg
║ Attribute: Files Part 2
║ Order: 12345
║ Customer: customer@example.com
╠═══════════════════════════════════════════════════════════════════
║ 📥 Download URL:
║ https://your-app.com/api/downloads/TOKEN2
╠═══════════════════════════════════════════════════════════════════
```

**Email:**
- Subject: "Your Sonic Drive Studio Downloads Are Ready! (Order #12345)"
- Body shows 2 download buttons:
  - "SDS Impulse Response MEGA bundle - Part 1 of 2"
  - "SDS Impulse Response MEGA bundle - Part 2 of 2"

### 4. Verify Database

Check DynamoDB tokens table:
- Should have 2 tokens for the order
- Each should have `fileGroup`, `fileIndex` (1, 2), `totalFiles` (2), and `fileName`

---

## Rollback Plan

If you need to rollback:

1. Restore from the backup:
   ```bash
   cp src/app/api/webhooks/saleor/order-fully-paid/use-case.ts.backup \
      src/app/api/webhooks/saleor/order-fully-paid/use-case.ts
   ```

2. Delete the new files:
   ```bash
   rm src/app/api/webhooks/saleor/order-fully-paid/file-utils.ts
   ```

3. Revert domain and database models to remove the optional fields

---

## Benefits of This Implementation

✅ **Backward Compatible**: Existing single-file products still work (optional fields)
✅ **No Schema Migration**: New fields are optional, no data migration needed
✅ **Clear UX**: Customers see "Part 1 of 2", "Part 2 of 2" in emails
✅ **Detailed Logging**: Console shows which file from which attribute
✅ **Multiple File Attributes**: Supports "Files", "Files Part 2", "Files Part 3", etc.
✅ **Multiple Values per Attribute**: Each attribute can have multiple file values
✅ **Secure**: Each file gets its own token with rate limiting

---

## Notes

- The `fileGroup` field groups files from the same product together
- The `fileIndex` is 1-based for user-friendly display (Part 1, Part 2, etc.)
- The `fileName` is extracted from the attribute value name or file URL
- Download limits apply PER FILE (each file token has its own 5 download limit)
- Media fallback removed to prevent product images from being downloaded
