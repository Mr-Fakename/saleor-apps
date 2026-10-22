/**
 * Server-side configuration for /api/add-configured-cable.
 *
 * Mirrors the dess storefront's configurator config
 * (storefront/apps/dess/client.config.ts, features.cableConfigurator): the
 * storefront only OFFERS these limits/options; this app ENFORCES them, because
 * the endpoint sets a custom line price that only an app may set.
 */

export const DEFAULT_CABLE_MIN_LENGTH_CM = 10;
export const DEFAULT_CABLE_MAX_LENGTH_CM = 5000;
export const DEFAULT_CABLE_PRODUCT_SLUG = "cable-custom";

/** The storefront's quantity selector allows 1..999. */
export const CABLE_MAX_QUANTITY = 999;

/**
 * Request field -> the base variant's reference attribute whose values are
 * the options offered for that slot (storefront cableConfigurator.attributes:
 * connectors / cable / sleeve). A reference is either a ProductVariant (used
 * as-is) or a Product (its default variant is the option) — the same
 * resolution the storefront does (packages/features/cable-configurator).
 */
export const CABLE_SLOT_ATTRIBUTES = {
  connecteur1Id: "connecteur-1",
  connecteur2Id: "connecteur-2",
  connecteur3Id: "connecteur-3",
  typeCableId: "reference-cable",
  referenceGaineId: "reference-gaine",
} as const;

export type CableSlot = keyof typeof CABLE_SLOT_ATTRIBUTES;

export type CableLimits = { minLengthCm: number; maxLengthCm: number };

function readPositiveNumber(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw.trim());

  return Number.isFinite(value) && value > 0 ? value : null;
}

/** CABLE_MIN_LENGTH_CM / CABLE_MAX_LENGTH_CM (cm); null when misconfigured. */
export function readCableLimits(): CableLimits | null {
  const minLengthCm = readPositiveNumber(process.env.CABLE_MIN_LENGTH_CM, DEFAULT_CABLE_MIN_LENGTH_CM);
  const maxLengthCm = readPositiveNumber(process.env.CABLE_MAX_LENGTH_CM, DEFAULT_CABLE_MAX_LENGTH_CM);

  if (minLengthCm === null || maxLengthCm === null || minLengthCm > maxLengthCm) {
    return null;
  }

  return { minLengthCm, maxLengthCm };
}

/** CABLE_PRODUCT_SLUG: the only product whose variants may be sold as configured cables. */
export function readCableProductSlug(): string {
  const raw = process.env.CABLE_PRODUCT_SLUG?.trim();

  return raw ? raw : DEFAULT_CABLE_PRODUCT_SLUG;
}

/**
 * Candidate slugs of the cable direction attribute, in the storefront's order
 * (storefront/apps/dess/client.config.ts features.cableConfigurator.attributes
 * .direction). The first one ASSIGNED TO THE BASE VARIANT picks the allow-list for
 * `directionCableId` (modules/cable/cable-direction.ts).
 */
export const CABLE_DIRECTION_ATTRIBUTE_SLUGS = ["direction-cable", "direction", "cable-direction"] as const;
