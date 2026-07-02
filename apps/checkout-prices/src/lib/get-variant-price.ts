/**
 * Resolve the custom per-unit price override for a checkout line, based on
 * quantity-tier ("bulk") pricing stored in the `quantityPricing` metafield.
 *
 * IMPORTANT: returns `undefined` when there is no quantity-tier pricing, so the
 * caller omits the `price` override entirely and lets Saleor price the line
 * natively. Passing an override here (especially the catalog-promotion-DISCOUNTED
 * `pricing.price`) makes Saleor re-apply the active catalog promotion on top of
 * the override — applying the discount twice (e.g. 879 → 747.15 → 635.08).
 *
 * When a tier DOES apply, the tier value is an absolute per-unit price from
 * metadata. The fallback base (used below the lowest threshold) is the
 * UNDISCOUNTED price so a tier never starts from an already-discounted base.
 */
export const getVariantPrice = (
  quantity: number,
  quantityPricingString: string | undefined | null,
  undiscountedPrice: number | undefined
): number | undefined => {
  // No quantity-tier pricing → no override; let Saleor apply promotions/taxes natively.
  if (!quantityPricingString) {
    return undefined;
  }

  let quantityPricing;

  try {
    // We are expecting the quantity pricing to be a JSON string
    // in format:
    // { "quantity": "price" }
    // So example for 10 items for $5 each and 20 items for $4 each:
    // { "10": "5", "20": "4" }

    quantityPricing = JSON.parse(quantityPricingString);
  } catch {
    // Invalid JSON string → no override
    return undefined;
  }

  // Start from the UNDISCOUNTED price (not the discounted `pricing.price`), so a
  // tier override is never derived from an already-discounted base.
  let quantityBasedPrice = undiscountedPrice;

  // Iterate over quantity thresholds and check if the quantity is in the range
  // Assuming thresholds are ordered from the lowest to the highest
  for (const [threshold, price] of Object.entries(quantityPricing)) {
    if (quantity >= parseInt(threshold, 10)) {
      quantityBasedPrice = parseFloat(price as string);
    } else {
      // Threshold is higher than the quantity, so we can break the loop
      break;
    }
  }

  return quantityBasedPrice;
};
