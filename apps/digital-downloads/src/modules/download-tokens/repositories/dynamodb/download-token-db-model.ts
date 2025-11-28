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
  expiresAt?: string; // undefined = infinite/never expires
  maxDownloads?: number; // undefined = unlimited downloads
  downloadCount: number;
  createdAt: string;
  lastAccessedAt?: string;
  // File grouping metadata
  fileGroup?: string;
  fileIndex?: number;
  totalFiles?: number;
  fileName?: string;
}

export class DownloadTokenEntity {
  constructor() {
    // Simple class for key generation utilities
  }

  /**
   * Generate primary key for a download token
   * Format: TOKEN#{token}
   */
  static getPrimaryKey({ token }: { token: string }): string {
    return `TOKEN#${token}`;
  }

  /**
   * Generate sort key for a download token
   * Format: METADATA
   */
  static getSortKey(): string {
    return "METADATA";
  }

  /**
   * Generate primary key for order-based queries
   * Format: ORDER#{orderId}
   */
  static getOrderPrimaryKey({ orderId }: { orderId: string }): string {
    return `ORDER#${orderId}`;
  }

  /**
   * Generate sort key for order-based queries
   * Format: TOKEN#{token}
   */
  static getOrderSortKey({ token }: { token: string }): string {
    return `TOKEN#${token}`;
  }
}
