import { NextRequest } from "next/server";

import { appConfigRepoImpl } from "@/modules/app-config/repositories/app-config-repo-impl";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { StripePaymentIntentsApi } from "@/modules/stripe/stripe-payment-intents-api";
import { createStripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";
import { StripeMoney } from "@/modules/stripe/stripe-money";
import { createLogger } from "@/lib/logger";
import { saleorApp } from "@/lib/saleor-app";

const logger = createLogger("update-payment-intent");

/**
 * Direct PaymentIntent amount update endpoint.
 *
 * Called by the storefront when a checkout total changes (e.g. PayPal fee toggle)
 * and the existing PaymentIntent needs its amount updated WITHOUT creating a new
 * Saleor transaction. This avoids the pspReference uniqueness conflict that occurs
 * when transactionInitialize tries to reuse an existing PI on a new transaction.
 *
 * The clientSecret remains valid after the update — no Elements remount needed.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      paymentIntentId?: string;
      amount?: number;
      currency?: string;
      channelId?: string;
      saleorApiUrl?: string;
    };

    if (!body.paymentIntentId || !body.amount || !body.currency || !body.channelId || !body.saleorApiUrl) {
      return Response.json(
        { error: "Missing required fields: paymentIntentId, amount, currency, channelId, saleorApiUrl" },
        { status: 400 },
      );
    }

    // Validate Saleor API URL
    const saleorApiUrlResult = createSaleorApiUrl(body.saleorApiUrl);
    if (saleorApiUrlResult.isErr()) {
      return Response.json({ error: "Invalid saleorApiUrl" }, { status: 400 });
    }
    const saleorApiUrl = saleorApiUrlResult.value;

    // Get app auth data (needed for appId to look up config)
    const authData = await saleorApp.apl.get(saleorApiUrl);
    if (!authData) {
      logger.error("No auth data found", { saleorApiUrl });
      return Response.json({ error: "App not installed for this Saleor instance" }, { status: 401 });
    }

    // Get Stripe config for this channel
    const configResult = await appConfigRepoImpl.getStripeConfig({
      channelId: body.channelId,
      appId: authData.appId,
      saleorApiUrl,
    });

    if (configResult.isErr()) {
      logger.error("Failed to get Stripe config", { error: configResult.error });
      return Response.json({ error: "Failed to retrieve Stripe configuration" }, { status: 500 });
    }

    const stripeConfig = configResult.value;
    if (!stripeConfig) {
      logger.warn("No Stripe config for channel", { channelId: body.channelId });
      return Response.json({ error: "Stripe not configured for this channel" }, { status: 404 });
    }

    // Convert amount
    const moneyResult = StripeMoney.createFromSaleorAmount({
      amount: body.amount,
      currency: body.currency,
    });

    if (moneyResult.isErr()) {
      return Response.json({ error: moneyResult.error.message }, { status: 400 });
    }

    // Update the PaymentIntent directly in Stripe
    const stripeApi = StripePaymentIntentsApi.createFromKey({ key: stripeConfig.restrictedKey });

    const paymentIntentId = createStripePaymentIntentId(body.paymentIntentId);

    const updateResult = await stripeApi.updatePaymentIntent({
      id: paymentIntentId,
      stripeMoney: moneyResult.value,
    });

    if (updateResult.isErr()) {
      logger.error("Stripe updatePaymentIntent failed", {
        paymentIntentId: body.paymentIntentId,
        error: updateResult.error,
      });
      return Response.json({ error: "Failed to update payment intent" }, { status: 500 });
    }

    const pi = updateResult.value;

    logger.info("PaymentIntent amount updated", {
      paymentIntentId: pi.id,
      amount: pi.amount,
      currency: pi.currency,
    });

    return Response.json({
      success: true,
      paymentIntentId: pi.id,
      amount: pi.amount,
      currency: pi.currency,
    });
  } catch (error) {
    logger.error("Unhandled error", { error });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
