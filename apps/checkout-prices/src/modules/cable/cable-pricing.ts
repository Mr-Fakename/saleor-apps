import { isProductId, isProductVariantId } from "../../lib/saleor-ids";
import type { CableSlot } from "./cable-config";

/**
 * Pure helpers for /api/add-configured-cable: which component variants a
 * base cable variant offers, and the configured price. Every amount comes
 * from Saleor (channel gross prices); nothing here reads the request body's
 * price fields.
 */

type ReferenceAttribute = {
  attribute: { slug?: string | null };
  values: ReadonlyArray<{ reference?: string | null }>;
};

/** References listed by the base variant's attribute for one slot. */
export function slotReferences(attributes: ReadonlyArray<ReferenceAttribute>, attributeSlug: string): string[] {
  const attribute = attributes.find((a) => a.attribute.slug === attributeSlug);

  return (attribute?.values ?? [])
    .map((value) => value.reference)
    .filter((reference): reference is string => typeof reference === "string" && reference.length > 0);
}

/** Product references whose default variant must be looked up. */
export function productReferences(references: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(references).filter(isProductId)));
}

/**
 * Variant IDs offered by a slot: a ProductVariant reference as-is, a Product
 * reference as its default variant (same resolution as the storefront).
 */
export function offeredVariantIds(
  references: ReadonlyArray<string>,
  defaultVariantByProduct: ReadonlyMap<string, string>,
): Set<string> {
  const offered = new Set<string>();

  for (const reference of references) {
    if (isProductVariantId(reference)) {
      offered.add(reference);
    } else {
      const defaultVariant = defaultVariantByProduct.get(reference);

      if (defaultVariant) {
        offered.add(defaultVariant);
      }
    }
  }

  return offered;
}

export type SelectedComponents = Partial<Record<CableSlot, string>>;

export interface CableComponentPrices {
  /** base (assembly) variant price */
  assembly: number;
  connector1: number;
  connector2: number;
  connector3: number | null;
  /** cable core price per metre */
  cablePerMeter: number;
  /** sleeve price per metre, null when no sleeve */
  gainePerMeter: number | null;
}

export interface CablePriceBreakdown {
  assemblyPrice: number;
  connector1Price: number;
  connector2Price: number;
  connector3Price: number;
  /** cable core €/m — reference only, not added on its own */
  cableBasePrice: number;
  /** cable core €/m × length */
  lengthPrice: number;
  /** sleeve €/m × length */
  gainePrice: number;
  /** sleeve €/m — reference only */
  gainePerMeterPrice: number;
  totalPrice: number;
}

/**
 * Same formula (and summation order) as the original handler:
 * assembly + connectors + sleeve €/m × m + cable €/m × m.
 */
export function priceCable(prices: CableComponentPrices, lengthCm: number): CablePriceBreakdown {
  const lengthInMeters = lengthCm / 100;
  const connector3Price = prices.connector3 ?? 0;
  const gainePerMeterPrice = prices.gainePerMeter ?? 0;
  const gainePrice = prices.gainePerMeter !== null ? prices.gainePerMeter * lengthInMeters : 0;
  const lengthPrice = prices.cablePerMeter * lengthInMeters;

  let totalPrice = 0;

  totalPrice += prices.assembly;
  totalPrice += prices.connector1;
  totalPrice += prices.connector2;
  totalPrice += connector3Price;
  totalPrice += gainePrice;
  totalPrice += lengthPrice;

  return {
    assemblyPrice: prices.assembly,
    connector1Price: prices.connector1,
    connector2Price: prices.connector2,
    connector3Price,
    cableBasePrice: prices.cablePerMeter,
    lengthPrice,
    gainePrice,
    gainePerMeterPrice,
    totalPrice,
  };
}
