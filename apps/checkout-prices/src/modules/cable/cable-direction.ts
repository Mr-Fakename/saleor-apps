import { CABLE_DIRECTION_ATTRIBUTE_SLUGS } from "./cable-config";

/**
 * NR-35: the direction (straight / angled) of a configured cable is chosen by
 * the shopper, but both its id and its label are request fields. The id must be
 * one of the values of the direction attribute ASSIGNED TO THE BASE VARIANT
 * (prod: `direction-cable`), and the label written to the line is Saleor's
 * name for that value — never the caller's text. A value of any other
 * attribute is refused, even one that exists in Saleor.
 */

export type DirectionAttribute = {
  slug?: string | null;
  choices?: { edges: Array<{ node: { id: string; name?: string | null } }> } | null;
} | null;

/**
 * The direction attribute slug the base variant actually carries: the first
 * candidate (config order) among the variant's attributes; null when it has none.
 */
export function assignedDirectionSlug(
  variantAttributes: ReadonlyArray<{ attribute: { slug?: string | null } }>,
): string | null {
  const assigned = new Set(variantAttributes.map((a) => a.attribute.slug));

  return CABLE_DIRECTION_ATTRIBUTE_SLUGS.find((slug) => assigned.has(slug)) ?? null;
}

/** The Saleor name of `directionId`, or null when it is not a value of `attribute`. */
export function resolveDirectionName(attribute: DirectionAttribute | undefined, directionId: string): string | null {
  const choice = attribute?.choices?.edges.find((edge) => edge.node.id === directionId);

  return choice?.node.name ? choice.node.name : null;
}
