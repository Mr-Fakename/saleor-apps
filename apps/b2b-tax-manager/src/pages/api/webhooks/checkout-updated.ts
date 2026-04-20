import { NextApiRequest, NextApiResponse } from "next";
import { createLogger } from "../../../logger";
import { saleorApp } from "../../../saleor-app";
import { createSaleorClient } from "../../../modules/saleor-client/saleor-graphql-client";
import { executeTaxExemption } from "../../../modules/tax-exemption/tax-exemption.use-case";
import { isEuCountry } from "../../../modules/vat-validation/vat-patterns";

const logger = createLogger("checkout-updated-webhook");

interface CheckoutUpdatedPayload {
  checkout?: {
    id: string;
    email?: string;
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
    const payload = req.body as CheckoutUpdatedPayload;
    const checkout = payload?.checkout;

    if (!checkout) {
      logger.warn("No checkout in webhook payload");
      return res.status(200).json({ message: "No checkout data" });
    }

    const billingCountry = checkout.billingAddress?.country?.code;

    if (!billingCountry) {
      logger.info("No billing address yet", { checkoutId: checkout.id });
      return res.status(200).json({ message: "No billing address" });
    }

    // Extract B2B metadata from checkout
    const metadata = checkout.metadata ?? [];
    const getMetaValue = (key: string) => metadata.find((m) => m.key === key)?.value;

    const vatNumber = getMetaValue("b2b_vat_number");
    const vatValidated = getMetaValue("b2b_vat_validated") === "true";
    const vatCountry = getMetaValue("b2b_vat_country");
    const previousCountry = getMetaValue("b2b_vat_country");
    const previousExemptReason = getMetaValue("b2b_tax_exempt_reason");

    // Decide if we need to re-evaluate:
    // 1. Non-EU billing country always gets export exemption
    // 2. If country changed from previous evaluation
    // 3. If there's a VAT number set
    const needsEvaluation =
      !isEuCountry(billingCountry) ||
      billingCountry !== previousCountry ||
      vatNumber;

    if (!needsEvaluation && previousExemptReason) {
      logger.info("No re-evaluation needed", { checkoutId: checkout.id });
      return res.status(200).json({ message: "No changes" });
    }

    // Get Saleor client
    const saleorApiUrl = req.headers["saleor-api-url"] as string;

    if (!saleorApiUrl) {
      logger.error("Missing saleor-api-url header");
      return res.status(400).json({ error: "Missing saleor-api-url header" });
    }

    const authData = await saleorApp.apl.get(saleorApiUrl);

    if (!authData) {
      logger.error("App not registered for this Saleor instance", { saleorApiUrl });
      return res.status(401).json({ error: "App not registered" });
    }

    const client = createSaleorClient(authData.saleorApiUrl, authData.token);

    // For reverse charge evaluation, use the VAT registration country
    // (not the billing address country). A business registered in DE with
    // a billing address in FR is still a German VAT entity for reverse charge.
    // For B2C (no VAT), use the billing address country.
    const countryForExemption = vatValidated && vatCountry
      ? vatCountry.toUpperCase()
      : billingCountry;

    const result = await executeTaxExemption(
      {
        checkoutId: checkout.id,
        billingCountryCode: countryForExemption,
        vatNumber: vatNumber ?? null,
        vatValidated,
      },
      client,
    );

    logger.info("Checkout tax exemption re-evaluated", {
      checkoutId: checkout.id,
      billingCountry,
      vatCountry: vatCountry ?? "none",
      countryForExemption,
      vatValidated,
      exempt: result.exempt,
      reason: result.reason,
    });

    return res.status(200).json({
      message: "Tax exemption evaluated",
      exempt: result.exempt,
      reason: result.reason,
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
