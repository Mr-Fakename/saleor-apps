import re

# Read the backup file
with open("src/app/api/webhooks/saleor/order-fully-paid/use-case.ts.backup", "r", encoding="utf-8") as f:
    content = f.read()

# Step 1: Add import after the last import
import_pattern = r'(import \{ generateOrderConfirmationEmail \} from "@/modules/email/order-confirmation-template";)'
import_replacement = r'\1\nimport { getFileUrls, type FileMetadata } from "./file-utils";'
content = re.sub(import_pattern, import_replacement, content)

# Step 2: Remove the old getFileUrl function (lines ~65-135)
# Find and remove everything from the JSDoc comment to the end of the function
old_function_pattern = r'/\*\*\s*\n\s*\* Extracts the file URL from a line item.*?^}\n'
content = re.sub(old_function_pattern, '', content, flags=re.DOTALL | re.MULTILINE)

# Step 3: Replace "const fileUrl = getFileUrl(line);" section
# This needs to be replaced with the multi-file loop
old_token_creation = r'(\s+for \(const line of digitalLines\) \{\s+const fileUrl = getFileUrl\(line\);.*?console\.log\("╚═══════════════════════════════════════════════════════════════════\n"\);\s+\})'

new_token_creation = '''      for (const line of digitalLines) {
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

        const totalFiles = fileMetadataList.length;
        const fileGroup = `${line.variant?.product?.id || line.productName}-files`;

        for (let fileIndex = 0; fileIndex < fileMetadataList.length; fileIndex++) {
          const fileMeta = fileMetadataList[fileIndex];
          const fileUrl = fileMeta.url;

          const tokenString = generateDownloadToken({
            orderId: order.id,
            fileUrl: fileUrl,
            expiresAt: expiryDate.toISOString(),
          });

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
            fileGroup: fileGroup,
            fileIndex: fileIndex + 1,
            totalFiles: totalFiles,
            fileName: fileMeta.name,
          });

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

          const downloadUrl = `${env.APP_API_BASE_URL}/api/downloads/${tokenString}`;

          logger.info("Download token created successfully", {
            orderId: order.id,
            lineId: line.id,
            fileIndex: fileIndex + 1,
            totalFiles: totalFiles,
            token: tokenString,
            downloadUrl: downloadUrl,
          });

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
      }'''

content = re.sub(old_token_creation, new_token_creation, content, flags=re.DOTALL)

# Step 4: Update version string
content = content.replace(
    'codeVersion: "2.0-with-attributes"',
    'codeVersion: "3.0-multi-file"'
)
content = content.replace(
    '"🚀 NEW CODE RUNNING - Processing ORDER_FULLY_PAID webhook v2 with attributes support"',
    '"🚀 Processing ORDER_FULLY_PAID webhook v3 with multi-file support"'
)

# Write the updated content
with open("src/app/api/webhooks/saleor/order-fully-paid/use-case.ts", "w", encoding="utf-8") as f:
    f.write(content)

print("use-case.ts updated successfully")
