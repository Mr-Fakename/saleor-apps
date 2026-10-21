import type { NextApiRequest, NextApiResponse } from "next";

import {
  AddLinesToCheckoutDocument,
  CheckoutDetailsFragment,
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
  CableOptionProductsDocument,
} from "../../modules/cable/cable-documents";
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

  // Line metadata — key names are a cross-repo contract (see header)
  const metadata: Array<{ key: string; value: string }> = [
    { key: "configurator_type", value: "cable" },
    { key: "config_fingerprint", value: configFingerprint },
    { key: "variant_name", value: configuration.variantName },
    { key: "connecteur_1_id", value: configuration.connecteur1Id },
    { key: "connecteur_1_name", value: configuration.connecteur1Name },
    { key: "connecteur_2_id", value: configuration.connecteur2Id },
    { key: "connecteur_2_name", value: configuration.connecteur2Name },
    { key: "type_cable_id", value: configuration.typeCableId },
    { key: "type_cable_name", value: configuration.typeCableName },
    { key: "direction_cable_id", value: configuration.directionCableId },
    { key: "direction_cable_name", value: configuration.directionCableName },
    { key: "longueur_cable_cm", value: configuration.longueurCable.toString() },
    { key: "longueur_cable_name", value: configuration.longueurCableName },
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
      { key: "connecteur_3_name", value: configuration.connecteur3Name ?? "" },
      { key: "component_connector3_price", value: price.connector3Price.toFixed(2) },
    );
  }
  if (configuration.referenceGaineId) {
    metadata.push(
      { key: "reference_gaine_id", value: configuration.referenceGaineId },
      { key: "reference_gaine_name", value: configuration.referenceGaineName ?? "" },
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

  return res.status(200).json({ checkout: updatedCheckout });
}
