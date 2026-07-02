import type { NextApiRequest, NextApiResponse } from "next";
import {
  AddLinesToCheckoutDocument,
  CheckoutDetailsFragment,
  CreateExampleCheckoutDocument,
  GetCheckoutDetailsDocument,
  GetVariantDetailsDocument,
} from "../../../generated/graphql";
import { createClient } from "../../lib/create-graphql-client";
import { DEFAULT_CHANNEL, SALEOR_API_URL } from "../../const";
import { apl } from "../../saleor-app";

type SuccessfulResponse = {
  checkout: CheckoutDetailsFragment;
};

type ErrorResponse = {
  errorMessage: string;
};

export type AddConfiguredCableResponseData = SuccessfulResponse | ErrorResponse;

interface CableConfiguration {
  connecteur1Id: string;
  connecteur2Id: string;
  connecteur3Id?: string | null;      // Y/Insert cables only
  typeCableId: string;
  referenceGaineId?: string | null;   // Optional sleeve
  directionCableId: string;
  longueurCable: number;              // length in cm
  variantName: string;
  connecteur1Name: string;
  connecteur2Name: string;
  connecteur3Name?: string | null;
  typeCableName: string;
  referenceGaineName?: string | null;
  directionCableName: string;
  longueurCableName: string;
  totalPrice: number;
  currency: string;
  configFingerprint: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<AddConfiguredCableResponseData>
) {
  console.info("Add configured cable has been called");

  // Validation of incoming data
  const baseVariantId = req.body.baseVariantId as string;
  if (!baseVariantId) {
    console.error("Base variant Id has not been specified");
    return res.status(400).json({ errorMessage: "baseVariantId has not been provided" });
  }

  const configuration = req.body.configuration as CableConfiguration;
  if (!configuration) {
    console.error("Configuration has not been specified");
    return res.status(400).json({ errorMessage: "configuration has not been provided" });
  }

  const quantity = req.body.quantity as number || 1;
  const checkoutId = req.body.checkoutId as string | undefined;

  console.debug("Incoming data has been validated");

  const client = createClient(SALEOR_API_URL, async () => {
    let authData = await apl.get(SALEOR_API_URL);

    // If SALEOR_API_URL fails, try to get any auth data (for single tenant apps)
    if (!authData) {
      console.log("[add-configured-cable] Auth data not found for configured URL, trying fallback to any auth data");
      const allAuth = await apl.getAll();
      if (allAuth.length > 0) {
        authData = allAuth[0];
        console.log("[add-configured-cable] Using fallback auth data for:", authData.saleorApiUrl);
      }
    }

    if (!authData) {
      throw new Error("No auth data found. Is the app installed?");
    }
    return Promise.resolve({ token: authData.token });
  });

  console.debug(`Getting details for base variant ${baseVariantId}`);

  // Get base variant (Cable Custom) details
  const baseVariantQuery = await client
    .query(GetVariantDetailsDocument, { channel: DEFAULT_CHANNEL, id: baseVariantId })
    .toPromise();

  if (baseVariantQuery.error) {
    console.error("Error while getting base variant details");
    console.error(baseVariantQuery.error);
    return res.status(400).json({
      errorMessage: `Could not pull data for base variant ${baseVariantId}. Error: ${baseVariantQuery.error.message}`,
    });
  }

  const baseVariant = baseVariantQuery.data?.productVariant;
  if (!baseVariant) {
    console.error(`Base variant ${baseVariantId} not found`);
    return res.status(400).json({ errorMessage: "Base variant not found" });
  }

  console.debug("Fetching component variant details for pricing calculation");

  // Build parallel fetch list: required components + optional ones
  const fetchPromises: Promise<any>[] = [
    client.query(GetVariantDetailsDocument, { channel: DEFAULT_CHANNEL, id: configuration.connecteur1Id }).toPromise(),
    client.query(GetVariantDetailsDocument, { channel: DEFAULT_CHANNEL, id: configuration.connecteur2Id }).toPromise(),
    client.query(GetVariantDetailsDocument, { channel: DEFAULT_CHANNEL, id: configuration.typeCableId }).toPromise(),
  ];

  // Optional: connector 3 (Y/Insert cables)
  const hasConnector3 = !!configuration.connecteur3Id;
  if (hasConnector3) {
    fetchPromises.push(
      client.query(GetVariantDetailsDocument, { channel: DEFAULT_CHANNEL, id: configuration.connecteur3Id! }).toPromise()
    );
  }

  // Optional: gaine/sleeve
  const hasGaine = !!configuration.referenceGaineId;
  if (hasGaine) {
    fetchPromises.push(
      client.query(GetVariantDetailsDocument, { channel: DEFAULT_CHANNEL, id: configuration.referenceGaineId! }).toPromise()
    );
  }

  const results = await Promise.all(fetchPromises);
  const [connector1Query, connector2Query, cableTypeQuery] = results;

  // Validate required component queries succeeded
  if (connector1Query.error || connector2Query.error || cableTypeQuery.error) {
    console.error("Error while fetching component variants");
    return res.status(400).json({
      errorMessage: "Could not fetch component variant details",
    });
  }

  const connector1 = connector1Query.data?.productVariant;
  const connector2 = connector2Query.data?.productVariant;
  const cableType = cableTypeQuery.data?.productVariant;

  if (!connector1 || !connector2 || !cableType) {
    console.error("One or more component variants not found:", {
      connector1: !!connector1,
      connector1Id: configuration.connecteur1Id,
      connector2: !!connector2,
      connector2Id: configuration.connecteur2Id,
      cableType: !!cableType,
      cableTypeId: configuration.typeCableId
    });
    return res.status(400).json({ errorMessage: "Component variants not found" });
  }

  // Extract optional component results
  let connector3Result = null;
  let gaineResult = null;
  let optIdx = 3;
  if (hasConnector3) {
    const q = results[optIdx++];
    if (q.error) {
      console.error("Error fetching connector 3:", q.error);
      return res.status(400).json({ errorMessage: "Could not fetch connector 3 details" });
    }
    connector3Result = q.data?.productVariant;
    if (!connector3Result) {
      return res.status(400).json({ errorMessage: `Connector 3 variant not found: ${configuration.connecteur3Id}` });
    }
  }
  if (hasGaine) {
    const q = results[optIdx++];
    if (q.error) {
      console.error("Error fetching gaine:", q.error);
      // Gaine is optional — log but don't fail
    } else {
      gaineResult = q.data?.productVariant ?? null;
    }
  }

  // Calculate total price from components and track individual prices for breakdown
  let totalPrice = 0;
  let currency = baseVariant.pricing?.price?.gross.currency || "EUR";

  // Component prices for breakdown display
  let assemblyPrice = 0;
  let connector1Price = 0;
  let connector2Price = 0;
  let connector3Price = 0;
  let gainePrice = 0; // scaled gaine charge (per-meter × length)
  let gainePerMeterPrice = 0; // gaine per-meter reference rate
  let cableBasePrice = 0;
  let lengthPrice = 0;

  // Add base assembly fee
  if (baseVariant.pricing?.price?.gross.amount) {
    assemblyPrice = baseVariant.pricing.price.gross.amount;
    totalPrice += assemblyPrice;
  }

  // Add connector 1 price
  if (connector1.pricing?.price?.gross.amount) {
    connector1Price = connector1.pricing.price.gross.amount;
    totalPrice += connector1Price;
  }

  // Add connector 2 price
  if (connector2.pricing?.price?.gross.amount) {
    connector2Price = connector2.pricing.price.gross.amount;
    totalPrice += connector2Price;
  }

  // Add connector 3 price (Y/Insert only)
  if (connector3Result?.pricing?.price?.gross.amount) {
    connector3Price = connector3Result.pricing.price.gross.amount;
    totalPrice += connector3Price;
  }

  // Gaine/sleeve per-meter reference rate (for transparency only — NOT added to total)
  if (gaineResult?.pricing?.price?.gross.amount) {
    gainePerMeterPrice = gaineResult.pricing.price.gross.amount;
  }

  // Calculate gaine cost (gaine price is per meter, like the cable) — this IS the gaine charge
  if (gaineResult?.pricing?.price?.gross.amount && configuration.longueurCable) {
    const lengthInMeters = configuration.longueurCable / 100;
    gainePrice = gaineResult.pricing.price.gross.amount * lengthInMeters;
    totalPrice += gainePrice;
  }

  // Cable type per-meter reference price (for transparency only — NOT added to total)
  if (cableType.pricing?.price?.gross.amount) {
    cableBasePrice = cableType.pricing.price.gross.amount;
  }

  // Calculate length cost (cable type price is per meter) — this IS the cable charge
  if (cableType.pricing?.price?.gross.amount && configuration.longueurCable) {
    const lengthInMeters = configuration.longueurCable / 100;
    lengthPrice = cableType.pricing.price.gross.amount * lengthInMeters;
    totalPrice += lengthPrice;
  }

  console.debug(`Calculated total price: ${totalPrice} ${currency} (quantity: ${quantity})`);
  console.debug(`Price breakdown - Assembly: ${assemblyPrice}, C1: ${connector1Price}, C2: ${connector2Price}, C3: ${connector3Price}, Gaine: ${gainePrice}, Cable: ${cableBasePrice}, Length: ${lengthPrice}`);

  // Use fingerprint from storefront (SHA256-based) for deduplication
  const configFingerprint = configuration.configFingerprint ||
    `${baseVariantId}|${configuration.connecteur1Id}|${configuration.connecteur2Id}|${configuration.connecteur3Id || ""}|${configuration.typeCableId}|${configuration.referenceGaineId || ""}|${configuration.directionCableId}|${configuration.longueurCable}`;

  // Prepare metadata for the checkout line
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
    { key: "total_price", value: totalPrice.toFixed(2) },
    { key: "currency", value: currency },
    // Component price breakdown for display in cart
    { key: "component_assembly_price", value: assemblyPrice.toFixed(2) },
    { key: "component_connector1_price", value: connector1Price.toFixed(2) },
    { key: "component_connector2_price", value: connector2Price.toFixed(2) },
    { key: "component_cable_price", value: cableBasePrice.toFixed(2) },
    { key: "component_length_price", value: lengthPrice.toFixed(2) },
  ];

  // Conditional metadata for optional components
  if (configuration.connecteur3Id && configuration.connecteur3Name) {
    metadata.push(
      { key: "connecteur_3_id", value: configuration.connecteur3Id },
      { key: "connecteur_3_name", value: configuration.connecteur3Name },
      { key: "component_connector3_price", value: connector3Price.toFixed(2) },
    );
  }
  if (configuration.referenceGaineId && configuration.referenceGaineName) {
    metadata.push(
      { key: "reference_gaine_id", value: configuration.referenceGaineId },
      { key: "reference_gaine_name", value: configuration.referenceGaineName },
      { key: "component_gaine_price", value: gainePrice.toFixed(2) },
      { key: "component_gaine_per_meter_price", value: gainePerMeterPrice.toFixed(2) },
    );
  }

  if (!checkoutId) {
    console.log("No checkout id provided - create a new checkout");

    const createCheckoutMutation = await client
      .mutation(CreateExampleCheckoutDocument, {
        input: {
          channel: DEFAULT_CHANNEL,
          lines: [
            {
              quantity: quantity,
              variantId: baseVariantId,
              price: totalPrice.toFixed(2),
              forceNewLine: true,  // Force separate line even on creation
              metadata: metadata,   // Include configuration metadata
            },
          ],
        },
      })
      .toPromise();

    if (createCheckoutMutation.error) {
      console.error(createCheckoutMutation.error);
      return res.status(400).json({
        errorMessage: `Could not create a new checkout. Error: ${createCheckoutMutation.error.message}`,
      });
    }

    const checkout = createCheckoutMutation.data?.checkoutCreate?.checkout;

    if (!checkout) {
      console.error("Checkout has not been created");
      return res.status(400).json({
        errorMessage: "Checkout has not been created",
      });
    }

    return res.status(200).json({
      checkout,
    });
  }

  console.log("Add configured cable to the existing checkout");

  // Get current checkout details
  const checkoutQuery = await client
    .query(GetCheckoutDetailsDocument, {
      id: checkoutId,
    })
    .toPromise();

  if (checkoutQuery.error) {
    console.error(checkoutQuery.error);
    return res.status(400).json({
      errorMessage: `Could not get checkout details. Error: ${checkoutQuery.error.message}`,
    });
  }

  const checkout = checkoutQuery.data?.checkout;

  if (!checkout) {
    console.error("Checkout has not been found");
    return res.status(400).json({
      errorMessage: "Checkout has not been found",
    });
  }

  // Add line to checkout with forceNewLine to ensure separate line items
  // DO NOT merge with existing lines - each cable configuration is unique
  const addLinesMutation = await client
    .mutation(AddLinesToCheckoutDocument, {
      id: checkoutId,
      lines: [
        {
          quantity: quantity,
          variantId: baseVariantId,
          price: totalPrice.toFixed(2),
          forceNewLine: true, // Force separate line items for each cable configuration
          metadata: metadata,  // Include all configuration details in metadata
        },
      ],
    })
    .toPromise();

  if (addLinesMutation.error) {
    console.error(addLinesMutation.error);
    return res.status(400).json({
      errorMessage: `Could not add line to checkout. Error: ${addLinesMutation.error.message}`,
    });
  }

  const updatedCheckout = addLinesMutation.data?.checkoutLinesAdd?.checkout;

  if (!updatedCheckout) {
    console.error("Adding lines to checkout has failed");
    return res.status(400).json({
      errorMessage: "Adding lines to checkout has failed",
    });
  }

  res.status(200).json({
    checkout: updatedCheckout,
  });
}
