import type { NextApiRequest, NextApiResponse } from "next";
import {
  CheckoutDetailsFragment,
  GetCheckoutDetailsDocument,
  GetVariantDetailsDocument,
  CheckoutLinesUpdateDocument,
  CheckoutLinesDeleteDocument,
} from "../../../generated/graphql";

// Note: The GraphQL mutations CheckoutLinesUpdate and CheckoutLinesDelete
// should be generated after running the code generator
import { createClient } from "../../lib/create-graphql-client";
import { getVariantPrice } from "../../lib/get-variant-price";
import { DEFAULT_CHANNEL, SALEOR_API_URL } from "../../const";
import { apl } from "../../saleor-app";

type SuccessfulResponse = {
  checkout: CheckoutDetailsFragment;
};

type ErrorResponse = {
  errorMessage: string;
};

export type UpdateLineQuantityResponseData = SuccessfulResponse | ErrorResponse;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<UpdateLineQuantityResponseData>
) {
  console.info("Update line quantity has been called");

  // Validation of incoming data
  const checkoutId = req.body.checkoutId as string;
  if (!checkoutId) {
    console.error("Checkout ID has not been specified");
    return res.status(400).json({ errorMessage: "checkoutId has not been provided" });
  }

  const lineId = req.body.lineId as string;
  if (!lineId) {
    console.error("Line ID has not been specified");
    return res.status(400).json({ errorMessage: "lineId has not been provided" });
  }

  const quantity = req.body.quantity as number;
  if (quantity === undefined || quantity === null) {
    console.error("Quantity has not been specified");
    return res.status(400).json({ errorMessage: "quantity has not been provided" });
  }

  console.debug("Incoming data has been validated");

  const client = createClient(SALEOR_API_URL, async () => {
    let authData = await apl.get(SALEOR_API_URL);

    // If SALEOR_API_URL fails, try to get any auth data (for single tenant apps)
    if (!authData) {
      console.log("[update-line-quantity] Auth data not found for configured URL, trying fallback");
      const allAuth = await apl.getAll();
      if (allAuth.length > 0) {
        authData = allAuth[0];
        console.log("[update-line-quantity] Using fallback auth data for:", authData.saleorApiUrl);
      }
    }

    if (!authData) {
      throw new Error("No auth data found. Is the app installed?");
    }
    return Promise.resolve({ token: authData.token });
  });

  // If quantity is 0, delete the line
  if (quantity === 0) {
    console.log("Quantity is 0, deleting line");

    const deleteMutation = await client
      .mutation(CheckoutLinesDeleteDocument, {
        checkoutId: checkoutId,
        lineIds: [lineId],
      })
      .toPromise();

    if (deleteMutation.error) {
      console.error(deleteMutation.error);
      return res.status(400).json({
        errorMessage: `Could not delete line. Error: ${deleteMutation.error.message}`,
      });
    }

    const checkout = deleteMutation.data?.checkoutLinesDelete?.checkout;

    if (!checkout) {
      console.error("Deleting line failed");
      return res.status(400).json({
        errorMessage: "Deleting line failed",
      });
    }

    return res.status(200).json({ checkout });
  }

  // Get checkout details to find the line
  const checkoutQuery = await client
    .query(GetCheckoutDetailsDocument, { id: checkoutId })
    .toPromise();

  if (checkoutQuery.error) {
    console.error(checkoutQuery.error);
    return res.status(400).json({
      errorMessage: `Could not get checkout details. Error: ${checkoutQuery.error.message}`,
    });
  }

  const checkout = checkoutQuery.data?.checkout;
  if (!checkout) {
    console.error("Checkout not found");
    return res.status(400).json({ errorMessage: "Checkout not found" });
  }

  // Find the line
  const line = checkout.lines.find((l) => l.id === lineId);
  if (!line) {
    console.error("Line not found in checkout");
    return res.status(400).json({ errorMessage: "Line not found in checkout" });
  }

  const variantId = line.variant.id;

  // Check if this is a configured product (has configurator_type metadata)
  const isConfiguredProduct = line.metadata?.some(
    (m) => m.key === "configurator_type"
  );

  let price: string | undefined;

  if (!isConfiguredProduct) {
    // For regular products, get variant details to check for quantity pricing
    console.debug(`Getting details for variant ${variantId}`);

    const variantQuery = await client
      .query(GetVariantDetailsDocument, { channel: DEFAULT_CHANNEL, id: variantId })
      .toPromise();

    if (variantQuery.error) {
      console.error("Error while getting variant details");
      console.error(variantQuery.error);
      return res.status(400).json({
        errorMessage: `Could not pull data for variant ${variantId}. Error: ${variantQuery.error.message}`,
      });
    }

    const productVariant = variantQuery.data?.productVariant;

    if (!productVariant) {
      console.error(`Product variant ${variantId} not found`);
      return res.status(400).json({ errorMessage: "Product variant not found" });
    }

    // Calculate price based on quantity (bulk pricing). Use the UNDISCOUNTED
    // price as the base and only override when a tier applies; otherwise Saleor
    // prices natively so catalog promotions aren't applied twice.
    const calculatedPrice = getVariantPrice(
      quantity,
      productVariant.quantityPricing,
      productVariant.pricing?.priceUndiscounted?.gross.amount
    );

    // Convert to string for GraphQL mutation
    if (calculatedPrice !== undefined) {
      price = calculatedPrice.toFixed(2);
    }

    console.debug(`Calculated price for quantity ${quantity}: ${price}`);
  }
  // For configured products, we keep the existing price (stored in metadata)

  // Update the line
  const updateMutation = await client
    .mutation(CheckoutLinesUpdateDocument, {
      checkoutId: checkoutId,
      lines: [
        {
          lineId: lineId,
          quantity: quantity,
          ...(price !== undefined ? { price: price } : {}),
        },
      ],
    })
    .toPromise();

  if (updateMutation.error) {
    console.error(updateMutation.error);
    return res.status(400).json({
      errorMessage: `Could not update line. Error: ${updateMutation.error.message}`,
    });
  }

  const updatedCheckout = updateMutation.data?.checkoutLinesUpdate?.checkout;

  if (!updatedCheckout) {
    console.error("Updating line failed");
    return res.status(400).json({
      errorMessage: "Updating line failed",
    });
  }

  res.status(200).json({
    checkout: updatedCheckout,
  });
}
