import type { NextApiRequest, NextApiResponse } from "next";
import {
  AddLinesToCheckoutDocument,
  CheckoutDetailsFragment,
  CheckoutLinesDeleteDocument,
  GetCheckoutDetailsDocument,
} from "../../../generated/graphql";
import { createClient } from "../../lib/create-graphql-client";
import { DEFAULT_CHANNEL, SALEOR_API_URL } from "../../const";
import { apl } from "../../saleor-app";

// This endpoint adds or removes a dynamic PayPal payment fee line on a checkout.
// The fee amount should be provided by the caller (storefront) to avoid
// discrepancies from missing fields in our local fragment (e.g., shipping).
// The line is created using a dedicated service variant, configured via env.
// Required env: PAYMENT_FEE_VARIANT_ID

const PAYMENT_FEE_METADATA_KEY = "payment_fee_type";
const PAYMENT_FEE_METADATA_VALUE = "paypal_2.9_percent";

type SuccessfulResponse = {
  checkout: CheckoutDetailsFragment;
};

type ErrorResponse = {
  errorMessage: string;
};

export type PaymentFeeResponse = SuccessfulResponse | ErrorResponse;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PaymentFeeResponse>
) {
  if (req.method !== "POST") {
    return res.status(405).json({ errorMessage: "Method not allowed" });
  }

  const { checkoutId, apply, amount, currency } = req.body as {
    checkoutId?: string;
    apply?: boolean; // true to add/update fee, false to remove
    amount?: number | string; // fee amount to set when apply=true
    currency?: string; // ISO currency for the price
  };

  if (!checkoutId) {
    return res.status(400).json({ errorMessage: "checkoutId has not been provided" });
  }
  if (apply === undefined) {
    return res.status(400).json({ errorMessage: "apply flag has not been provided" });
  }

  const FEE_VARIANT_ID = process.env.PAYMENT_FEE_VARIANT_ID;
  if (!FEE_VARIANT_ID && apply) {
    return res.status(500).json({
      errorMessage:
        "PAYMENT_FEE_VARIANT_ID is not configured. Please set a service variant ID for fee lines.",
    });
  }

  const client = createClient(SALEOR_API_URL, async () => {
    let authData = await apl.get(SALEOR_API_URL);
    if (!authData) {
      const all = await apl.getAll();
      if (all.length > 0) authData = all[0];
    }
    if (!authData) {
      throw new Error("No auth data found. Is the app installed?");
    }
    return Promise.resolve({ token: authData.token });
  });

  // Fetch current checkout to find existing fee line if any
  const checkoutQuery = await client
    .query(GetCheckoutDetailsDocument, { id: checkoutId })
    .toPromise();

  if (checkoutQuery.error) {
    return res.status(400).json({
      errorMessage: `Could not get checkout details. Error: ${checkoutQuery.error.message}`,
    });
  }

  const checkout = checkoutQuery.data?.checkout;
  if (!checkout) {
    return res.status(404).json({ errorMessage: "Checkout not found" });
  }

  // Try to locate an existing fee line by metadata
  const existingFeeLine = checkout.lines.find((line) =>
    line.metadata?.some((m) => m.key === PAYMENT_FEE_METADATA_KEY && m.value === PAYMENT_FEE_METADATA_VALUE)
  );

  // If apply=false, remove fee line if exists and return
  if (!apply) {
    if (existingFeeLine) {
      const del = await client
        .mutation(CheckoutLinesDeleteDocument, {
          checkoutId: checkout.id,
          lineIds: [existingFeeLine.id],
        })
        .toPromise();

      if (del.error) {
        return res.status(400).json({
          errorMessage: `Could not delete fee line. Error: ${del.error.message}`,
        });
      }

      const updated = del.data?.checkoutLinesDelete?.checkout;
      if (!updated) {
        return res.status(400).json({ errorMessage: "Deleting fee line failed" });
      }
      return res.status(200).json({ checkout: updated });
    }

    // No fee to remove, return current checkout
    return res.status(200).json({ checkout });
  }

  // From here, apply=true -> add or update fee line
  if (amount === undefined || amount === null) {
    return res.status(400).json({ errorMessage: "amount has not been provided" });
  }

  // Normalize price to string with 2 decimals as Saleor expects PositiveDecimal
  const normalizedAmount = typeof amount === "number" ? amount.toFixed(2) : amount;

  if (existingFeeLine) {
    // Update the existing line price using CheckoutLinesUpdate
    // Note: Our project includes CheckoutLinesUpdateDocument in update-line-quantity.ts
    // To avoid a separate import dependency here, perform delete+add for simplicity and idempotency.
    const del = await client
      .mutation(CheckoutLinesDeleteDocument, {
        checkoutId: checkout.id,
        lineIds: [existingFeeLine.id],
      })
      .toPromise();

    if (del.error) {
      return res.status(400).json({
        errorMessage: `Could not update fee line (delete failed). Error: ${del.error.message}`,
      });
    }
  }

  // Add the fee as a new forced line using the configured service variant
  const add = await client
    .mutation(AddLinesToCheckoutDocument, {
      id: checkout.id,
      lines: [
        {
          quantity: 1,
          variantId: FEE_VARIANT_ID!,
          price: normalizedAmount,
          forceNewLine: true,
          metadata: [
            { key: PAYMENT_FEE_METADATA_KEY, value: PAYMENT_FEE_METADATA_VALUE },
            { key: "display_name", value: "Service fee (2.9%)" },
            ...(currency ? [{ key: "currency", value: String(currency) }] : []),
          ],
        },
      ],
    })
    .toPromise();

  if (add.error) {
    return res.status(400).json({
      errorMessage: `Could not add fee line. Error: ${add.error.message}`,
    });
  }

  const updatedCheckout = add.data?.checkoutLinesAdd?.checkout;
  if (!updatedCheckout) {
    return res.status(400).json({ errorMessage: "Adding fee line failed" });
  }

  return res.status(200).json({ checkout: updatedCheckout });
}
