import { NextApiRequest, NextApiResponse } from "next";
import { createLogger } from "../../../logger";
import { saleorApp } from "../../../saleor-app";
import { createSaleorClient } from "../../../modules/saleor-client/saleor-graphql-client";

const logger = createLogger("order-created-webhook");

const SELLER_VAT_NUMBER = process.env.SELLER_VAT_NUMBER ?? "";

interface OrderCreatedPayload {
  order?: {
    id: string;
    number?: string;
    billingAddress?: {
      country: {
        code: string;
      };
      companyName?: string;
    };
    metadata?: Array<{
      key: string;
      value: string;
    }>;
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload = req.body as OrderCreatedPayload;
    const order = payload?.order;

    if (!order) {
      logger.warn("No order in webhook payload");
      return res.status(200).json({ message: "No order data" });
    }

    const metadata = order.metadata ?? [];
    const getMetaValue = (key: string) => metadata.find((m) => m.key === key)?.value;

    const reverseCharge = getMetaValue("b2b_reverse_charge");
    const vatNumber = getMetaValue("b2b_vat_number");
    const taxExemptReason = getMetaValue("b2b_tax_exempt_reason");

    // Only process B2B orders
    if (!reverseCharge && !vatNumber) {
      logger.info("Not a B2B order, skipping", { orderId: order.id });
      return res.status(200).json({ message: "Not B2B" });
    }

    // Get Saleor client
    const saleorApiUrl = req.headers["saleor-api-url"] as string;

    if (!saleorApiUrl) {
      logger.error("Missing saleor-api-url header");
      return res.status(400).json({ error: "Missing saleor-api-url header" });
    }

    const authData = await saleorApp.apl.get(saleorApiUrl);

    if (!authData) {
      logger.error("App not registered for this Saleor instance");
      return res.status(401).json({ error: "App not registered" });
    }

    const client = createSaleorClient(authData.saleorApiUrl, authData.token);

    // Build order metadata with B2B fields
    const orderMetadata: Array<{ key: string; value: string }> = [];

    if (reverseCharge) {
      orderMetadata.push({ key: "b2b_reverse_charge", value: reverseCharge });
    }
    if (vatNumber) {
      orderMetadata.push({ key: "b2b_buyer_vat_number", value: vatNumber });
    }
    if (SELLER_VAT_NUMBER) {
      orderMetadata.push({ key: "b2b_seller_vat_number", value: SELLER_VAT_NUMBER });
    }
    if (taxExemptReason) {
      orderMetadata.push({ key: "b2b_tax_exempt_reason", value: taxExemptReason });
    }

    if (orderMetadata.length > 0) {
      await client.updateOrderMetadata(order.id, orderMetadata);

      logger.info("B2B metadata copied to order", {
        orderId: order.id,
        orderNumber: order.number,
        reverseCharge,
        keys: orderMetadata.map((m) => m.key),
      });
    }

    return res.status(200).json({
      message: "B2B metadata processed",
      reverseCharge: reverseCharge === "true",
    });
  } catch (error) {
    logger.error("Webhook processing error", { error: String(error) });
    return res.status(500).json({ error: "Internal server error" });
  }
}

export const config = {
  api: {
    bodyParser: true,
  },
};
