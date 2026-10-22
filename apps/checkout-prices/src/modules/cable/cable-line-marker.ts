/**
 * Proof that a configured-cable line's metadata was written by this app
 * (payments review 2026-10-21, A3b / regression NR-33).
 *
 * Line PUBLIC metadata is writable by anyone holding the checkout: Saleor
 * accepts `metadata` on public checkoutLinesAdd / checkoutLinesUpdate and
 * `updateMetadata(id: <CheckoutLine id>)` needs no permission at all
 * (saleor/graphql/meta/permissions.py PUBLIC_META_PERMISSION_MAP). So a
 * shopper can put a forged 50 m cable description on the cheap base variant.
 *
 * Line PRIVATE metadata needs MANAGE_CHECKOUTS or HANDLE_TAXES
 * (PRIVATE_META_PERMISSION_MAP -> checkout_permissions); this app has
 * MANAGE_CHECKOUTS. Saleor copies it onto the order line at checkout
 * completion (saleor/checkout/complete_checkout.py _create_line_for_order:
 * `private_metadata=checkout_line.private_metadata`). After adding a cable the
 * app therefore records, privately, exactly the public metadata it wrote; the
 * dashboard's cable dialog compares the order line's public metadata with that
 * record and flags any line without a matching one as unverified.
 *
 * Cross-repo contract — keep in sync with saleor-dashboard
 * src/orders/components/OrderCableConfigurationDialog/cableConfiguration.ts.
 */

export type MetadataEntry = { key: string; value: string };

/** PRIVATE line-metadata key holding the record (see buildCableConfigMarker). */
export const CABLE_CONFIG_MARKER_KEY = "checkout_prices.cable_config";

/**
 * PUBLIC line-metadata key: a random reference generated per add, so the app
 * can find the line it just created in the mutation result. A shopper cannot
 * know it before the line exists; a later copy of it on another line gets no
 * record, and an ambiguous reference gets no record at all (findLineByRef).
 */
export const CABLE_LINE_REF_KEY = "cable_line_ref";

export const CABLE_CONFIG_MARKER_VERSION = 1;

/**
 * Stable log messages (error level) for alerting on a configured cable the
 * app could not record (the add then fails with 503 and the line is removed). Do not reword: log alerts match on them.
 */
export const MARKER_WRITE_FAILED_LOG = "[add-configured-cable] cable_marker_write_failed";
export const MARKER_LINE_NOT_FOUND_LOG = "[add-configured-cable] cable_marker_line_not_found";
/** The unmarked line could not be removed either: an app-priced line without a record exists. */
export const MARKER_ROLLBACK_FAILED_LOG = "[add-configured-cable] cable_marker_rollback_failed";

/** Whether private line metadata carries the marker (set only by this app). */
export const hasCableMarker = (privateMetadata: ReadonlyArray<{ key: string }>): boolean =>
  privateMetadata.some((entry) => entry.key === CABLE_CONFIG_MARKER_KEY);

const compareKeys = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Canonical record: JSON `{"v":1,"metadata":{<key>:<value>,…}}`, keys in
 * code-unit order. A repeated key keeps its LAST value, the same as Saleor's
 * metadata dict. (Object key order is insertion order because no contract key
 * is an integer-like string; the dashboard compares parsed values anyway.)
 */
export function buildCableConfigMarker(metadata: ReadonlyArray<MetadataEntry>): string {
  const byKey = new Map<string, string>();

  for (const { key, value } of metadata) {
    byKey.set(key, value);
  }
  const sorted = Array.from(byKey.entries()).sort(([a], [b]) => compareKeys(a, b));

  return JSON.stringify({ v: CABLE_CONFIG_MARKER_VERSION, metadata: Object.fromEntries(sorted) });
}

/** The ONE line carrying `lineRef`; null when none or several do (fail safe). */
export function findLineByRef<L extends { id: string; metadata: ReadonlyArray<MetadataEntry> }>(
  lines: ReadonlyArray<L>,
  lineRef: string,
): L | null {
  const matches = lines.filter((line) =>
    line.metadata.some((entry) => entry.key === CABLE_LINE_REF_KEY && entry.value === lineRef),
  );

  return matches.length === 1 ? matches[0] : null;
}
