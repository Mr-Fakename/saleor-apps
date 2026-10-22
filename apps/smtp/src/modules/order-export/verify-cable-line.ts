/**
 * NR-33 / NR-36: is an order line's PUBLIC cable metadata exactly what
 * checkout-prices recorded in the line's PRIVATE metadata when it priced the
 * cable? Public line metadata is writable by any shopper; the private marker is
 * not.
 *
 * Cross-repo rule — keep identical to saleor-dashboard
 * src/orders/components/OrderCableConfigurationDialog/cableConfiguration.ts
 * (verifyCableConfiguration); both are pinned by the same golden vectors.
 *
 *  1. no marker                         -> "missing-marker"
 *  2. marker unreadable (not JSON, v != 1, metadata not a string map)
 *                                       -> "invalid-marker"
 *  3. compare the WHOLE public key set with the marker's. Keys containing a
 *     "." belong to other apps (namespaced) and are ignored on both sides.
 *     Any extra, missing or changed key -> "modified" (changedKeys sorted)
 *  4. otherwise                         -> "verified"
 */

export const CABLE_CONFIG_MARKER_KEY = "checkout_prices.cable_config";
const CABLE_CONFIG_MARKER_VERSION = 1;

export type CableVerificationResult = {
  result: "verified" | "missing-marker" | "invalid-marker" | "modified";
  changedKeys: string[];
};

type MetadataObject = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asObject = (value: unknown): MetadataObject => (isRecord(value) ? value : {});

const publicEntries = (metadata: MetadataObject): Map<string, string> => {
  const entries = new Map<string, string>();

  for (const [key, value] of Object.entries(metadata)) {
    if (!key.includes(".")) {
      entries.set(key, typeof value === "string" ? value : String(value));
    }
  }

  return entries;
};

const parseMarker = (raw: unknown): Map<string, string> | null => {
  if (typeof raw !== "string") {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed.v !== CABLE_CONFIG_MARKER_VERSION || !isRecord(parsed.metadata)) {
    return null;
  }

  const recorded = new Map<string, string>();

  for (const [key, value] of Object.entries(parsed.metadata)) {
    if (typeof value !== "string") {
      return null;
    }
    if (!key.includes(".")) {
      recorded.set(key, value);
    }
  }

  return recorded;
};

/** `metadata` / `privateMetadata` are Saleor's key -> value maps (Postgres jsonb). */
export const verifyCableLine = (
  metadata: MetadataObject | null | undefined,
  privateMetadata: MetadataObject | null | undefined,
): CableVerificationResult => {
  const rawMarker = asObject(privateMetadata)[CABLE_CONFIG_MARKER_KEY];

  if (rawMarker === undefined) {
    return { result: "missing-marker", changedKeys: [] };
  }

  const recorded = parseMarker(rawMarker);

  if (!recorded) {
    return { result: "invalid-marker", changedKeys: [] };
  }

  const current = publicEntries(asObject(metadata));
  const changedKeys = Array.from(new Set([...current.keys(), ...recorded.keys()]))
    .filter(key => current.get(key) !== recorded.get(key))
    .sort();

  return changedKeys.length === 0
    ? { result: "verified", changedKeys }
    : { result: "modified", changedKeys };
};

export const CABLE_VERIFIED_COLUMN = "Câble vérifié";
const CABLE_FLAG_COLUMN = "Cable personnalise";
const RAW_PUBLIC = "__metadata";
const RAW_PRIVATE = "__private_metadata";
const RAW_IS_CABLE_PRODUCT = "__is_cable_product";
const RAW_CREATED_AT = "__created_at";
const RAW_COLUMNS = new Set([RAW_PUBLIC, RAW_PRIVATE, RAW_IS_CABLE_PRODUCT, RAW_CREATED_AT]);

/**
 * What the cells mean. "oui" says ONLY that the line's public metadata equals
 * the record checkout-prices wrote privately when it priced the cable. Since
 * checkout-prices writes Saleor's own names and prices into both, "oui" also
 * means the labels and prices are the catalogue's; it is not a statement about
 * anything else on the order (payment, address, ...). The dashboard dialog
 * shows the same verdict, in words (verified / modified / not verified).
 */
const LABELS: Record<CableVerificationResult["result"], string> = {
  verified: "oui",
  "missing-marker": "non",
  "invalid-marker": "non",
  modified: "modifié",
};

/** Unmarked line of an order that predates the verification: expected, not suspicious. */
export const BEFORE_VERIFICATION_LABEL = "non (avant vérification)";

/**
 * CABLE_VERIFICATION_CUTOFF (optional env, ISO date or datetime). Orders
 * created before it that have no marker get BEFORE_VERIFICATION_LABEL instead
 * of a plain "non". Unset, empty or unparseable = no cutoff (plain "non").
 */
export const parseCableVerificationCutoff = (raw: string | undefined): Date | null => {
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  const date = new Date(raw.trim());

  return Number.isNaN(date.getTime()) ? null : date;
};

const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string") {
    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
};

/**
 * Adds the "Câble vérifié" column (oui / non / non (avant vérification) /
 * modifié) right after "Cable personnalise" and removes the raw columns the SQL
 * selects for it (__metadata, __private_metadata, __is_cable_product,
 * __created_at).
 *
 * A line is a cable line when its product is the cable product
 * (__is_cable_product, from the SQL: product slug = CABLE_PRODUCT_SLUG) OR the
 * private marker exists (a shopper can delete the public key, not the marker).
 * The public configurator_type alone no longer counts: it is shopper-writable,
 * so a line of another product that claims it gets an empty cell.
 *
 * Remaining differences with the dashboard dialog: the dialog opens on a line's
 * public configurator_type (or marker) and needs no product lookup; the CSV
 * keeps its "Cable personnalise" column on the public key. A forged
 * configurator_type on a non-cable product therefore opens the dialog (showing
 * "not verified") but is blank here.
 */
export const addCableVerificationColumn = (
  fields: string[],
  rows: Array<Record<string, unknown>>,
  options: { cutoff?: Date | null } = {},
): { fields: string[]; rows: Array<Record<string, unknown>> } => {
  const cutoff = options.cutoff ?? null;
  const outFields: string[] = [];

  for (const field of fields) {
    if (RAW_COLUMNS.has(field)) {
      continue;
    }
    outFields.push(field);
    if (field === CABLE_FLAG_COLUMN) {
      outFields.push(CABLE_VERIFIED_COLUMN);
    }
  }

  const outRows = rows.map(row => {
    const {
      [RAW_PUBLIC]: rawPublic,
      [RAW_PRIVATE]: rawPrivate,
      [RAW_IS_CABLE_PRODUCT]: isCableProduct,
      [RAW_CREATED_AT]: createdAt,
      ...rest
    } = row;
    const publicMetadata = asObject(rawPublic);
    const privateMetadata = asObject(rawPrivate);
    const isCable = isCableProduct === true || privateMetadata[CABLE_CONFIG_MARKER_KEY] !== undefined;

    if (!isCable) {
      return { ...rest, [CABLE_VERIFIED_COLUMN]: "" };
    }
    const { result } = verifyCableLine(publicMetadata, privateMetadata);
    const created = toDate(createdAt);
    const label =
      result === "missing-marker" && cutoff !== null && created !== null && created < cutoff
        ? BEFORE_VERIFICATION_LABEL
        : LABELS[result];

    return { ...rest, [CABLE_VERIFIED_COLUMN]: label };
  });

  return { fields: outFields, rows: outRows };
};
