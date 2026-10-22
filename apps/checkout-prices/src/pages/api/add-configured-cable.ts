import { randomUUID } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";

import {
  AddLinesToCheckoutDocument,
  CheckoutDetailsFragment,
  CheckoutLinesDeleteDocument,
  CreateExampleCheckoutDocument,
  GetVariantDetailsDocument,
} from "../../../generated/graphql";
import { DEFAULT_CHANNEL } from "../../const";
import { createAppGraphQLClient } from "../../lib/app-graphql-client";
import { handleCors } from "../../lib/cors";
import { checkoutLogRef } from "../../lib/saleor-ids";
import {
  CABLE_SLOT_ATTRIBUTES,
  type CableSlot,
  readCableLimits,
  readCableProductSlug,
} from "../../modules/cable/cable-config";
import {
  CABLE_OPTION_PRODUCTS_PAGE_SIZE,
  CableBaseVariantDocument,
  CableCheckoutChannelDocument,
  CableDirectionChoicesDocument,
  CableLineMarkerDocument,
  CableNamesDocument,
  CableOptionProductsDocument,
} from "../../modules/cable/cable-documents";
import {
  buildCableConfigMarker,
  CABLE_CONFIG_MARKER_KEY,
  CABLE_LINE_REF_KEY,
  findLineByRef,
  MARKER_LINE_NOT_FOUND_LOG,
  MARKER_ROLLBACK_FAILED_LOG,
  MARKER_WRITE_FAILED_LOG,
  type MetadataEntry,
} from "../../modules/cable/cable-line-marker";
import { assignedDirectionSlug, resolveDirectionName } from "../../modules/cable/cable-direction";
import { indexNames, productLabel, variantLabel } from "../../modules/cable/cable-names";
import {
  offeredVariantIds,
  priceCable,
  productReferences,
  slotReferences,
} from "../../modules/cable/cable-pricing";
import { parseCableRequest } from "../../modules/cable/parse-cable-request";

// Adds a configured cable as ONE checkout line on the base "cable-custom"
// variant, with a custom price the app computes from Saleor channel prices:
// assembly (base variant) + connectors + sleeve €/m × length + cable €/m ×
// length. The request carries only identifiers, the length and the quantity;
// the storefront's `totalPrice` estimate is ignored. Each component must be
// one of the options the base variant's reference attributes offer for its
// slot (modules/cable/cable-config.ts), so no other catalogue item can be
// priced into — or sold at the price of — a cable.
//
// Caller: the storefront server action (no Origin header). Line-metadata keys
// are a cross-repo contract: storefront/packages/features/cable-configurator/
// src/metadata-contract.ts.
//
// Verification (NR-33): anyone can put the same PUBLIC metadata on the base
// variant through Saleor's public API, priced at the assembly fee only. After
// adding the line the app records, in the line's PRIVATE metadata, exactly the
// public metadata it wrote (modules/cable/cable-line-marker.ts); Saleor copies
// it onto the order line and the dashboard's cable dialog checks it.
//
// Fail closed: if the record cannot be written (after one retry) or the new line
// cannot be identified, the just-added line is DELETED and the caller gets 503
// "please retry": an app-priced cable line never exists without its record.
//
// Names (P1-a): every label in the metadata and the record (variant, connectors,
// cable, sleeve, direction, length) is Saleor's, in the checkout's language;
// the request's *Name fields are ignored. So "the metadata matches the record"
// also means "the labels are the catalogue's".

type CheckoutError = { field?: string | null; message?: string | null; code: string };

type SuccessfulResponse = {
  checkout: CheckoutDetailsFragment;
};

type ErrorResponse = {
  errorMessage: string;
  errors?: CheckoutError[];
};

export type AddConfiguredCableResponseData = SuccessfulResponse | ErrorResponse;

const SLOT_LABELS: Record<CableSlot, string> = {
  connecteur1Id: "connector 1",
  connecteur2Id: "connector 2",
  connecteur3Id: "connector 3",
  typeCableId: "cable type",
  referenceGaineId: "sleeve",
};

type AppGraphQLClient = ReturnType<typeof createAppGraphQLClient>;

/**
 * NR-33: write the PRIVATE verification record on the line this request just
 * created (found by its fresh `cable_line_ref`). One retry for a transient
 * failure. Returns false when the record could not be written or the line could
 * not be identified: the caller must then remove the line (rollbackCableLine).
 * Both cases log at error level with a stable message for alerting.
 */
async function recordCableConfiguration(
  client: AppGraphQLClient,
  checkout: CheckoutDetailsFragment,
  lineRef: string,
  metadata: ReadonlyArray<MetadataEntry>,
): Promise<boolean> {
  const logRef = checkoutLogRef(checkout.id);
  const line = findLineByRef(checkout.lines, lineRef);

  if (!line) {
    // none, or several (a copied reference): never guess which line is ours
    console.error(MARKER_LINE_NOT_FOUND_LOG, { checkout: logRef });

    return false;
  }

  const input = [{ key: CABLE_CONFIG_MARKER_KEY, value: buildCableConfigMarker(metadata) }];
  let failure: { error?: string; errors?: unknown } = {};

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await client.mutation(CableLineMarkerDocument, { id: line.id, input }).toPromise();
    const errors = result.data?.updatePrivateMetadata?.errors ?? [];

    if (!result.error && result.data?.updatePrivateMetadata && errors.length === 0) {
      return true;
    }
    failure = { error: result.error?.message, errors };
  }

  console.error(MARKER_WRITE_FAILED_LOG, { checkout: logRef, ...failure });

  return false;
}

/**
 * Remove every line carrying this request's reference (normally the one line it
 * added; a copied reference would add more, and those are not legitimate
 * either). If the delete fails too, the stable MARKER_ROLLBACK_FAILED_LOG is
 * logged next to the earlier MARKER_WRITE_FAILED_LOG / MARKER_LINE_NOT_FOUND_LOG.
 */
async function rollbackCableLine(
  client: AppGraphQLClient,
  checkout: CheckoutDetailsFragment,
  lineRef: string,
): Promise<void> {
  const logRef = checkoutLogRef(checkout.id);
  const lineIds = checkout.lines
    .filter((line) => line.metadata.some((entry) => entry.key === CABLE_LINE_REF_KEY && entry.value === lineRef))
    .map((line) => line.id);

  if (lineIds.length === 0) {
    console.error(MARKER_ROLLBACK_FAILED_LOG, { checkout: logRef, reason: "line not found" });

    return;
  }
  const result = await client.mutation(CheckoutLinesDeleteDocument, { checkoutId: checkout.id, lineIds }).toPromise();
  const errors = result.data?.checkoutLinesDelete?.errors ?? [];

  if (result.error || errors.length > 0) {
    console.error(MARKER_ROLLBACK_FAILED_LOG, { checkout: logRef, error: result.error?.message, errors });
  }
}

const RETRY_MESSAGE = "The cable could not be added to your cart. Please retry.";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<AddConfiguredCableResponseData>,
) {
  if (handleCors(req, res, { methods: ["POST", "OPTIONS"] })) {
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).json({ errorMessage: "Method not allowed" });
  }

  console.info("Add configured cable has been called");

  const limits = readCableLimits();

  if (!limits) {
    console.error("[add-configured-cable] CABLE_MIN_LENGTH_CM / CABLE_MAX_LENGTH_CM are invalid");

    return res.status(500).json({ errorMessage: "Cable length limits are misconfigured" });
  }

  const parsed = parseCableRequest(req.body, limits);

  if (!parsed.ok) {
    console.warn("[add-configured-cable] Rejected request:", parsed.error);

    return res.status(400).json({ errorMessage: parsed.error });
  }

  const { checkoutId, baseVariantId, quantity, configuration } = parsed.value;
  const client = createAppGraphQLClient("add-configured-cable");
  // Checkout.languageCode: the language Saleor names are read in (unset for a new checkout)
  let checkoutLanguage: string | null = null;

  // 1. Base variant (+ the target checkout's channel, in parallel)
  const [baseVariantQuery, checkoutQuery] = await Promise.all([
    client.query(CableBaseVariantDocument, { id: baseVariantId, channel: DEFAULT_CHANNEL }).toPromise(),
    checkoutId ? client.query(CableCheckoutChannelDocument, { id: checkoutId }).toPromise() : Promise.resolve(null),
  ]);

  if (baseVariantQuery.error) {
    console.error("Error while getting base variant details", baseVariantQuery.error.message);

    return res.status(400).json({
      errorMessage: `Could not pull data for base variant ${baseVariantId}. Error: ${baseVariantQuery.error.message}`,
    });
  }

  const baseVariant = baseVariantQuery.data?.productVariant;

  if (!baseVariant) {
    return res.status(400).json({ errorMessage: "Base variant not found" });
  }

  if (baseVariant.product.slug !== readCableProductSlug()) {
    console.warn("[add-configured-cable] Base variant is not a configurable cable", {
      productSlug: baseVariant.product.slug,
    });

    return res.status(400).json({ errorMessage: "Base variant is not a configurable cable" });
  }

  const basePrice = baseVariant.pricing?.price?.gross;

  if (!basePrice) {
    return res.status(400).json({ errorMessage: "Base variant has no price in this channel" });
  }

  if (checkoutQuery) {
    if (checkoutQuery.error) {
      return res.status(400).json({
        errorMessage: `Could not get checkout details. Error: ${checkoutQuery.error.message}`,
      });
    }
    const checkout = checkoutQuery.data?.checkout;

    if (!checkout) {
      return res.status(400).json({ errorMessage: "Checkout has not been found" });
    }
    if (checkout.channel.slug !== DEFAULT_CHANNEL) {
      return res.status(400).json({ errorMessage: "Checkout belongs to another channel" });
    }
    checkoutLanguage = checkout.languageCode || null;
  }

  // 1b. NR-35: the direction must be a value of the direction attribute assigned
  // to THIS base variant, and its label is Saleor's, never the caller's. Fails closed.
  const directionSlug = assignedDirectionSlug(baseVariant.attributes);

  if (directionSlug === null) {
    console.warn("[add-configured-cable] Base variant has no direction attribute");

    return res.status(400).json({ errorMessage: "The selected cable direction is not available" });
  }
  const directionQuery = await client.query(CableDirectionChoicesDocument, { slug: directionSlug }).toPromise();

  if (directionQuery.error) {
    console.error("Error while resolving cable direction options", directionQuery.error.message);

    return res.status(400).json({ errorMessage: "Could not resolve the cable's direction options" });
  }
  const directionName = resolveDirectionName(directionQuery.data?.attribute, configuration.directionCableId);

  if (directionName === null) {
    console.warn("[add-configured-cable] Direction is not a value of the base variant's direction attribute");

    return res.status(400).json({ errorMessage: "The selected cable direction is not available" });
  }

  // 2. Every selected component must be an option of the base variant's slot
  const selected = (Object.keys(CABLE_SLOT_ATTRIBUTES) as CableSlot[]).flatMap((slot) => {
    const variantId = configuration[slot];

    return variantId ? [{ slot, variantId }] : [];
  });

  const referencesBySlot = new Map<CableSlot, string[]>(
    selected.map(({ slot }) => [slot, slotReferences(baseVariant.attributes, CABLE_SLOT_ATTRIBUTES[slot])]),
  );

  // Y/Insert variants (connector-3 options present) need a third connector,
  // as the storefront requires — otherwise it would be sold unpriced.
  const connector3Missing = !configuration.connecteur3Id;

  if (connector3Missing) {
    referencesBySlot.set(
      "connecteur3Id",
      slotReferences(baseVariant.attributes, CABLE_SLOT_ATTRIBUTES.connecteur3Id),
    );
  }
  const productIds = productReferences(Array.from(referencesBySlot.values()).flat());
  const defaultVariantByProduct = new Map<string, string>();

  for (let start = 0; start < productIds.length; start += CABLE_OPTION_PRODUCTS_PAGE_SIZE) {
    const optionsQuery = await client
      .query(CableOptionProductsDocument, {
        ids: productIds.slice(start, start + CABLE_OPTION_PRODUCTS_PAGE_SIZE),
        channel: DEFAULT_CHANNEL,
      })
      .toPromise();

    if (optionsQuery.error) {
      console.error("Error while resolving cable options", optionsQuery.error.message);

      return res.status(400).json({ errorMessage: "Could not resolve the cable's component options" });
    }
    for (const edge of optionsQuery.data?.products?.edges ?? []) {
      if (edge.node.defaultVariant) {
        defaultVariantByProduct.set(edge.node.id, edge.node.defaultVariant.id);
      }
    }
  }

  if (
    connector3Missing &&
    offeredVariantIds(referencesBySlot.get("connecteur3Id") ?? [], defaultVariantByProduct).size > 0
  ) {
    return res.status(400).json({ errorMessage: "This cable requires a third connector (connecteur3Id)" });
  }

  for (const { slot, variantId } of selected) {
    const offered = offeredVariantIds(referencesBySlot.get(slot) ?? [], defaultVariantByProduct);

    if (!offered.has(variantId)) {
      console.warn("[add-configured-cable] Component is not an option of the base variant", {
        slot,
        attribute: CABLE_SLOT_ATTRIBUTES[slot],
        offeredOptions: offered.size,
      });

      return res.status(400).json({
        errorMessage: `The selected ${SLOT_LABELS[slot]} is not available for this cable`,
      });
    }
  }

  // 3. Component channel prices — a component without a price is an error, never free
  const componentQueries = await Promise.all(
    selected.map(({ variantId }) =>
      client.query(GetVariantDetailsDocument, { channel: DEFAULT_CHANNEL, id: variantId }).toPromise(),
    ),
  );
  const unitPrices = new Map<CableSlot, number>();

  for (let index = 0; index < selected.length; index += 1) {
    const { slot } = selected[index];
    const query = componentQueries[index];

    if (query.error) {
      console.error(`Error while fetching ${SLOT_LABELS[slot]} details`, query.error.message);

      return res.status(400).json({ errorMessage: `Could not fetch ${SLOT_LABELS[slot]} details` });
    }
    const gross = query.data?.productVariant?.pricing?.price?.gross;

    if (!gross) {
      return res.status(400).json({ errorMessage: `The selected ${SLOT_LABELS[slot]} has no price in this channel` });
    }
    if (gross.currency !== basePrice.currency) {
      return res.status(400).json({ errorMessage: `The selected ${SLOT_LABELS[slot]} is priced in another currency` });
    }
    unitPrices.set(slot, gross.amount);
  }

  // 3b. P1-a: Saleor's labels for the base variant and every component. The
  // request's *Name fields are not read anywhere below.
  const nameQuery = await client
    .query(CableNamesDocument, {
      ids: [baseVariantId, ...selected.map(({ variantId }) => variantId)],
      channel: DEFAULT_CHANNEL,
      tr: checkoutLanguage !== null,
      ...(checkoutLanguage !== null ? { lang: checkoutLanguage } : {}),
    })
    .toPromise();

  if (nameQuery.error) {
    console.error("Error while resolving cable component names", nameQuery.error.message);

    return res.status(400).json({ errorMessage: "Could not resolve the cable's component names" });
  }
  const names = indexNames(nameQuery.data);
  const componentNames = new Map<CableSlot, string>();

  for (const { slot, variantId } of selected) {
    // a product reference is labelled with its product, a variant reference with the variant
    const isVariantReference = (referencesBySlot.get(slot) ?? []).includes(variantId);
    const label = isVariantReference ? variantLabel(names, variantId) : productLabel(names, variantId);

    if (!label) {
      console.warn("[add-configured-cable] No name for a selected component", { slot });

      return res.status(400).json({ errorMessage: `Could not resolve the selected ${SLOT_LABELS[slot]}` });
    }
    componentNames.set(slot, label);
  }
  const baseName = variantLabel(names, baseVariantId);

  if (!baseName) {
    return res.status(400).json({ errorMessage: "Could not resolve the cable's variant name" });
  }
  const nameOf = (slot: CableSlot): string => componentNames.get(slot) ?? "";

  const requiredPrice = (slot: CableSlot): number => unitPrices.get(slot) ?? 0;

  // 4. Price — every amount from Saleor
  const price = priceCable(
    {
      assembly: basePrice.amount,
      connector1: requiredPrice("connecteur1Id"),
      connector2: requiredPrice("connecteur2Id"),
      connector3: unitPrices.get("connecteur3Id") ?? null,
      cablePerMeter: requiredPrice("typeCableId"),
      gainePerMeter: unitPrices.get("referenceGaineId") ?? null,
    },
    configuration.longueurCable,
  );
  const currency = basePrice.currency;

  if (!(price.totalPrice > 0)) {
    return res.status(400).json({ errorMessage: "Configured cable has no payable price" });
  }

  console.debug(`Calculated total price: ${price.totalPrice} ${currency} (quantity: ${quantity})`);

  // Fingerprint from the storefront (SHA256-based) for deduplication
  const configFingerprint =
    configuration.configFingerprint ||
    `${baseVariantId}|${configuration.connecteur1Id}|${configuration.connecteur2Id}|${configuration.connecteur3Id || ""}|${configuration.typeCableId}|${configuration.referenceGaineId || ""}|${configuration.directionCableId}|${configuration.longueurCable}`;

  // Fresh per request: identifies the line this request creates (NR-33).
  const lineRef = randomUUID();

  // Line metadata — key names are a cross-repo contract (see header)
  const metadata: MetadataEntry[] = [
    { key: "configurator_type", value: "cable" },
    { key: "config_fingerprint", value: configFingerprint },
    { key: CABLE_LINE_REF_KEY, value: lineRef },
    { key: "variant_name", value: baseName },
    { key: "connecteur_1_id", value: configuration.connecteur1Id },
    { key: "connecteur_1_name", value: nameOf("connecteur1Id") },
    { key: "connecteur_2_id", value: configuration.connecteur2Id },
    { key: "connecteur_2_name", value: nameOf("connecteur2Id") },
    { key: "type_cable_id", value: configuration.typeCableId },
    { key: "type_cable_name", value: nameOf("typeCableId") },
    { key: "direction_cable_id", value: configuration.directionCableId },
    // Saleor's name for the value (NR-35) — the caller's directionCableName is ignored
    { key: "direction_cable_name", value: directionName },
    { key: "longueur_cable_cm", value: configuration.longueurCable.toString() },
    { key: "longueur_cable_name", value: `${configuration.longueurCable}cm` },
    { key: "total_price", value: price.totalPrice.toFixed(2) },
    { key: "currency", value: currency },
    // Component price breakdown for display in cart
    { key: "component_assembly_price", value: price.assemblyPrice.toFixed(2) },
    { key: "component_connector1_price", value: price.connector1Price.toFixed(2) },
    { key: "component_connector2_price", value: price.connector2Price.toFixed(2) },
    { key: "component_cable_price", value: price.cableBasePrice.toFixed(2) },
    { key: "component_length_price", value: price.lengthPrice.toFixed(2) },
  ];

  if (configuration.connecteur3Id) {
    metadata.push(
      { key: "connecteur_3_id", value: configuration.connecteur3Id },
      { key: "connecteur_3_name", value: nameOf("connecteur3Id") },
      { key: "component_connector3_price", value: price.connector3Price.toFixed(2) },
    );
  }
  if (configuration.referenceGaineId) {
    metadata.push(
      { key: "reference_gaine_id", value: configuration.referenceGaineId },
      { key: "reference_gaine_name", value: nameOf("referenceGaineId") },
      { key: "component_gaine_price", value: price.gainePrice.toFixed(2) },
      { key: "component_gaine_per_meter_price", value: price.gainePerMeterPrice.toFixed(2) },
    );
  }

  const line = {
    quantity,
    variantId: baseVariantId,
    price: price.totalPrice.toFixed(2),
    forceNewLine: true, // each configuration is its own line — never merge
    metadata,
  };

  if (!checkoutId) {
    console.log("No checkout id provided - create a new checkout");

    const createCheckoutMutation = await client
      .mutation(CreateExampleCheckoutDocument, {
        input: { channel: DEFAULT_CHANNEL, lines: [line] },
      })
      .toPromise();

    if (createCheckoutMutation.error) {
      console.error("Could not create a new checkout", createCheckoutMutation.error.message);

      return res.status(400).json({
        errorMessage: `Could not create a new checkout. Error: ${createCheckoutMutation.error.message}`,
      });
    }

    const checkout = createCheckoutMutation.data?.checkoutCreate?.checkout;

    if (!checkout) {
      return res.status(400).json({ errorMessage: "Checkout has not been created" });
    }

    if (!(await recordCableConfiguration(client, checkout, lineRef, metadata))) {
      await rollbackCableLine(client, checkout, lineRef);

      return res.status(503).json({ errorMessage: RETRY_MESSAGE });
    }

    return res.status(200).json({ checkout });
  }

  console.log("Add configured cable to the existing checkout");

  const addLinesMutation = await client
    .mutation(AddLinesToCheckoutDocument, { id: checkoutId, lines: [line] })
    .toPromise();

  if (addLinesMutation.error) {
    console.error("Could not add line to checkout", addLinesMutation.error.message);

    return res.status(400).json({
      errorMessage: `Could not add line to checkout. Error: ${addLinesMutation.error.message}`,
    });
  }

  const updatedCheckout = addLinesMutation.data?.checkoutLinesAdd?.checkout;

  if (!updatedCheckout) {
    // See add-to-cart.ts — Saleor puts the reason in checkoutLinesAdd.errors.
    const errors = addLinesMutation.data?.checkoutLinesAdd?.errors ?? [];

    console.error("Adding lines to checkout has failed", { checkout: checkoutLogRef(checkoutId), errors });

    return res.status(400).json({
      errorMessage: errors.length
        ? errors.map((e) => `${e.code}: ${e.message ?? "no message"}`).join("; ")
        : "Adding lines to checkout has failed",
      errors,
    });
  }

  if (!(await recordCableConfiguration(client, updatedCheckout, lineRef, metadata))) {
    await rollbackCableLine(client, updatedCheckout, lineRef);

    return res.status(503).json({ errorMessage: RETRY_MESSAGE });
  }

  return res.status(200).json({ checkout: updatedCheckout });
}
