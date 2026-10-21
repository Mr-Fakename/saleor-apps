import { createHash } from "crypto";

/**
 * Saleor global-ID validation for request bodies.
 *
 * A Saleor global ID is base64("<Type>:<pk>"). For a checkout the pk IS the
 * checkout token, a random UUIDv4 (saleor/checkout/models.py: `token =
 * UUIDField(primary_key=True, default=uuid4)`; graphql/checkout/types.py
 * `resolve_id` -> to_global_id("Checkout", pk)). The checkout ID and the
 * checkout token therefore carry the same secret, and Saleor's public API
 * accepts either as the bearer credential for checkout mutations.
 */

const MAX_GLOBAL_ID_LENGTH = 128;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER_PK = /^[1-9][0-9]*$/;

function decodeGlobalId(value: unknown): { type: string; pk: string } | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_GLOBAL_ID_LENGTH || !BASE64.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const separator = decoded.indexOf(":");

  if (separator <= 0) {
    return null;
  }

  return { type: decoded.slice(0, separator), pk: decoded.slice(separator + 1) };
}

/** base64("Checkout:<uuid>") */
export function isCheckoutId(value: unknown): value is string {
  const decoded = decodeGlobalId(value);

  return decoded !== null && decoded.type === "Checkout" && UUID.test(decoded.pk);
}

/** base64("ProductVariant:<int>") */
export function isProductVariantId(value: unknown): value is string {
  const decoded = decodeGlobalId(value);

  return decoded !== null && decoded.type === "ProductVariant" && INTEGER_PK.test(decoded.pk);
}

/** base64("Product:<int>") */
export function isProductId(value: unknown): value is string {
  const decoded = decodeGlobalId(value);

  return decoded !== null && decoded.type === "Product" && INTEGER_PK.test(decoded.pk);
}

/**
 * Non-reversible reference to a checkout for logs. The checkout ID is a
 * bearer credential (see above), so it must not be written to logs verbatim.
 */
export function checkoutLogRef(checkoutId: string): string {
  return `checkout#${createHash("sha256").update(checkoutId).digest("hex").slice(0, 12)}`;
}
