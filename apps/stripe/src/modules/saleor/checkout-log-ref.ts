import { createHash } from "crypto";

/**
 * Non-reversible reference to a checkout for logs. A checkout ID is base64("Checkout:<token>")
 * and Saleor's public API accepts it as the bearer credential for checkout mutations, so it
 * must not be written to logs verbatim. Same format as checkout-prices' `checkoutLogRef`.
 */
export const checkoutLogRef = (checkoutId: string): string =>
  `checkout#${createHash("sha256").update(checkoutId).digest("hex").slice(0, 12)}`;
