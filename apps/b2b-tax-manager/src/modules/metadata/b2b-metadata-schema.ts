import { z } from "zod";

/**
 * User privateMetadata keys for B2B information.
 */
export const userB2bMetadataSchema = z.object({
  b2b_is_business: z.enum(["true", "false"]),
  b2b_vat_number: z.string().min(4).max(15).regex(/^[A-Z]{2}[A-Z0-9]+$/),
  b2b_vat_validated: z.enum(["true", "false"]),
  b2b_vat_validated_at: z.string().datetime(),
  b2b_vat_country: z.string().length(2).regex(/^[A-Z]{2}$/),
  b2b_company_legal_name: z.string().min(1).max(255),
});

/**
 * Checkout metadata keys for B2B tax processing.
 */
export const checkoutB2bMetadataSchema = z.object({
  b2b_vat_number: z.string().min(4).max(15).regex(/^[A-Z]{2}[A-Z0-9]+$/),
  b2b_vat_validated: z.enum(["true", "false"]),
  b2b_reverse_charge: z.enum(["true", "false"]),
  b2b_tax_exempt_reason: z.enum([
    "INTRA_EU_REVERSE_CHARGE",
    "NON_EU_EXPORT",
    "DOMESTIC_B2B",
    "INTRA_EU_NO_VALID_VAT",
    "DOMESTIC_B2C",
  ]),
});

/**
 * Order metadata keys copied from checkout on completion.
 */
export const orderB2bMetadataSchema = z.object({
  b2b_reverse_charge: z.enum(["true", "false"]),
  b2b_buyer_vat_number: z.string().min(4).max(15),
  b2b_seller_vat_number: z.string().min(4).max(15),
  b2b_tax_exempt_reason: z.enum([
    "INTRA_EU_REVERSE_CHARGE",
    "NON_EU_EXPORT",
    "DOMESTIC_B2B",
    "INTRA_EU_NO_VALID_VAT",
    "DOMESTIC_B2C",
  ]),
});

export type UserB2bMetadata = z.infer<typeof userB2bMetadataSchema>;
export type CheckoutB2bMetadata = z.infer<typeof checkoutB2bMetadataSchema>;
export type OrderB2bMetadata = z.infer<typeof orderB2bMetadataSchema>;

/**
 * Extract B2B metadata from a Saleor metadata array.
 */
export function extractB2bMetadata(
  metadata: Array<{ key: string; value: string }>,
): Record<string, string> {
  const b2bKeys = new Set([
    ...Object.keys(userB2bMetadataSchema.shape),
    ...Object.keys(checkoutB2bMetadataSchema.shape),
    ...Object.keys(orderB2bMetadataSchema.shape),
  ]);

  const result: Record<string, string> = {};
  for (const { key, value } of metadata) {
    if (b2bKeys.has(key)) {
      result[key] = value;
    }
  }
  return result;
}
