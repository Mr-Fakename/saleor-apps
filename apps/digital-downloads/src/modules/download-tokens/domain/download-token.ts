import { z } from "zod";

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
});

export type DownloadToken = z.infer<typeof downloadTokenSchema>;

export const createDownloadToken = (
  data: Omit<DownloadToken, "downloadCount" | "createdAt" | "lastAccessedAt">,
): DownloadToken => {
  return downloadTokenSchema.parse({
    ...data,
    downloadCount: 0,
    createdAt: new Date().toISOString(),
  });
};
