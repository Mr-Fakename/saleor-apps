import crypto from "crypto";

import { env } from "@/lib/env";

export interface DownloadTokenPayload {
  orderId: string;
  fileUrl: string;
  expiresAt: string;
}

/**
 * Generates a secure HMAC-SHA256 signed download token
 * Format: base64(payload).signature
 *
 * @param data - Token payload containing orderId, fileUrl, and expiresAt
 * @returns A signed token string
 */
export function generateDownloadToken(data: DownloadTokenPayload): string {
  const payload = `${data.orderId}:${data.fileUrl}:${data.expiresAt}`;
  const hmac = crypto.createHmac("sha256", env.SECRET_KEY);

  hmac.update(payload);

  const signature = hmac.digest("hex");
  const encodedPayload = Buffer.from(payload).toString("base64");

  return `${encodedPayload}.${signature}`;
}

/**
 * Parses a download token and extracts the payload
 *
 * @param token - The signed token string
 * @returns The parsed payload or null if invalid format
 */
export function parseDownloadToken(token: string): DownloadTokenPayload | null {
  try {
    const [encodedPayload] = token.split(".");

    if (!encodedPayload) {
      return null;
    }

    const payload = Buffer.from(encodedPayload, "base64").toString("utf-8");
    // Split on first two colons only, as the fileUrl contains colons
    const parts = payload.split(":");

    if (parts.length < 3) {
      return null;
    }

    const orderId = parts[0];
    // Join everything except first and last part for the fileUrl
    const fileUrl = parts.slice(1, -1).join(":");
    const expiresAt = parts[parts.length - 1];

    if (!orderId || !fileUrl || !expiresAt) {
      return null;
    }

    return {
      orderId,
      fileUrl,
      expiresAt,
    };
  } catch {
    return null;
  }
}
