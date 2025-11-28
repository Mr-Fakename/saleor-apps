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
 *
 * @param line - The order line item
 * @param productAttributesOverride - Optional product attributes fetched from API (bypasses webhook attributes)
 */
export function getFileUrls(line: any, productAttributesOverride?: any[]): FileMetadata[] {
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
  // Use override if provided (fetched from API), otherwise use webhook attributes
  const productAttributes = productAttributesOverride || line?.variant?.product?.attributes || [];

  // Collect file attributes - check by name pattern AND by whether values have file data
  for (const attr of productAttributes) {
    const attributeName = attr?.attribute?.name || "";
    const isFileByName = isFileAttribute(attributeName);
    const values = attr?.values || [];

    // Check if any values have file URLs (this is the most reliable check)
    const hasFileData = values.some((v: any) => v?.file?.url);

    // Include if: (1) name matches file patterns, OR (2) has actual file data
    if (isFileByName || hasFileData) {
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

  return fileMetadataList;
}
