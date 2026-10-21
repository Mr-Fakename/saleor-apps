import { NextRequest } from "next/server";

import { env } from "@/lib/env";
import { createInstrumentedGraphqlClient } from "@/lib/graphql-client";
import { createLogger } from "@/lib/logger";
import { saleorApp } from "@/lib/saleor-app";
import { appConfigRepoImpl } from "@/modules/app-config/repositories/app-config-repo-impl";
import { CheckoutPaymentStateFetcher } from "@/modules/saleor/checkout-payment-state-fetcher";
import { StripePaymentIntentsApiFactory } from "@/modules/stripe/stripe-payment-intents-api-factory";

import { RequestOriginPolicy } from "./request-origin-policy";
import { UpdatePaymentIntentAmountUseCase, updatePaymentIntentRequestSchema } from "./use-case";

const logger = createLogger("update-payment-intent");

const originPolicy = RequestOriginPolicy.fromAllowList(env.UPDATE_PAYMENT_INTENT_ALLOWED_ORIGINS);

const useCase = new UpdatePaymentIntentAmountUseCase({
  apl: saleorApp.apl,
  appConfigRepo: appConfigRepoImpl,
  stripePaymentIntentsApiFactory: new StripePaymentIntentsApiFactory(),
  checkoutPaymentStateFetcherFactory: (authData) =>
    new CheckoutPaymentStateFetcher(
      createInstrumentedGraphqlClient({
        // The APL's https-enforced URL, so the app token never goes out over plain http.
        saleorApiUrl: authData.saleorApiUrl,
        token: authData.token,
      }),
    ),
});

const forbiddenOriginResponse = () =>
  Response.json({ error: "Origin not allowed" }, { status: 403 });

/**
 * CORS preflight. Only reachable for origins in UPDATE_PAYMENT_INTENT_ALLOWED_ORIGINS;
 * the storefront proxies call POST server-to-server and never preflight.
 */
export async function OPTIONS(req: NextRequest) {
  const decision = originPolicy.evaluate(req.headers.get("origin"));

  if (!decision.allowed || Object.keys(decision.corsHeaders).length === 0) {
    return new Response(null, { status: 403 });
  }

  return new Response(null, {
    status: 204,
    headers: {
      ...decision.corsHeaders,
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    },
  });
}

/**
 * Re-syncs an existing PaymentIntent's amount to its Saleor checkout.
 *
 * Called by the storefront when the checkout total changes (e.g. PayPal fee line
 * added/removed) so the PaymentIntent follows WITHOUT a new Saleor transaction. The
 * clientSecret stays valid, so Elements does not remount.
 *
 * The amount is computed on the server from the checkout (see use-case.ts); the body's
 * `amount` is only compared and logged (regression NR-02).
 */
export async function POST(req: NextRequest) {
  const decision = originPolicy.evaluate(req.headers.get("origin"));

  if (!decision.allowed) {
    logger.warn("Rejected request from a browser origin that is not allowed", {
      origin: decision.origin,
    });

    return forbiddenOriginResponse();
  }

  const headers = decision.corsHeaders;

  try {
    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Request body must be JSON" }, { status: 400, headers });
    }

    const parsedBody = updatePaymentIntentRequestSchema.safeParse(body);

    if (!parsedBody.success) {
      return Response.json(
        {
          error:
            "Missing or invalid required fields: paymentIntentId, amount, currency, channelId, saleorApiUrl",
        },
        { status: 400, headers },
      );
    }

    const result = await useCase.execute(parsedBody.data);

    return result.match(
      (success) =>
        Response.json(
          {
            success: true,
            paymentIntentId: success.paymentIntentId,
            amount: success.amount,
            currency: success.currency,
          },
          { headers },
        ),
      (error) => {
        const logAttributes = {
          paymentIntentId: parsedBody.data.paymentIntentId,
          channelId: parsedBody.data.channelId,
          httpStatus: error.httpStatus,
          error,
        };

        if (error.httpStatus >= 500) {
          logger.error("PaymentIntent amount update failed", logAttributes);
        } else {
          logger.warn("PaymentIntent amount update refused", logAttributes);
        }

        return Response.json(
          { error: error.publicMessage },
          { status: error.httpStatus, headers },
        );
      },
    );
  } catch (error) {
    logger.error("Unhandled error", { error });

    return Response.json({ error: "Internal server error" }, { status: 500, headers });
  }
}
