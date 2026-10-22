import type { CableNamesQuery } from "./cable-documents";

/**
 * Saleor's labels for a configured cable (P1-a). The request's *Name fields
 * are never trusted: the public metadata AND the verification marker carry
 * these, so the dashboard and the CSV export can vouch for them.
 *
 * Same rule as the storefront configurator
 * (storefront/packages/features/cable-configurator/src/routes/page.tsx):
 * a PRODUCT reference shows the product's name, a direct VARIANT reference the
 * variant's name; each is "translation?.name || name" in the checkout's language.
 */

type NameNode = NonNullable<CableNamesQuery["productVariants"]>["edges"][number]["node"];

const pick = (translated: string | null | undefined, base: string): string => translated || base;

/** Index the query result by variant ID. */
export function indexNames(data: CableNamesQuery | undefined): Map<string, NameNode> {
  return new Map((data?.productVariants?.edges ?? []).map((edge) => [edge.node.id, edge.node]));
}

/** The variant's own (translated) name — the base variant and direct variant references. */
export function variantLabel(names: ReadonlyMap<string, NameNode>, variantId: string): string | null {
  const node = names.get(variantId);

  return node ? pick(node.translation?.name, node.name) : null;
}

/** The (translated) name of the variant's product — product references (the option IS the product). */
export function productLabel(names: ReadonlyMap<string, NameNode>, variantId: string): string | null {
  const node = names.get(variantId);

  return node ? pick(node.product.translation?.name, node.product.name) : null;
}
