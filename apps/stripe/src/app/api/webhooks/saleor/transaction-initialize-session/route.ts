import { ObservabilityAttributes } from "@saleor/apps-otel/src/observability-attributes";
import { withSpanAttributesAppRouter } from "@saleor/apps-otel/src/with-span-attributes";
import { compose } from "@saleor/apps-shared/compose";
import { captureException } from "@sentry/nextjs";

import {
  MalformedRequestResponse,
  UnhandledErrorResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import { appContextContainer } from "@/lib/app-context";
import { env } from "@/lib/env";
import { BaseError } from "@/lib/errors";
import { createInstrumentedGraphqlClient } from "@/lib/graphql-client";
import { createLogger } from "@/lib/logger";
import { loggerContext, withLoggerContext } from "@/lib/logger-context";
import { setObservabilitySaleorApiUrl } from "@/lib/observability-saleor-api-url";
import { setObservabilitySourceObjectId } from "@/lib/observability-source-object-id";
import { saleorApp } from "@/lib/saleor-app";
import { appConfigRepoImpl } from "@/modules/app-config/repositories/app-config-repo-impl";
import { paymentFeeGateFromEnv } from "@/modules/payment-fee-gate/payment-fee-gate-config";
import { CheckoutPaymentStateFetcher } from "@/modules/saleor/checkout-payment-state-fetcher";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { StripePaymentIntentsApiFactory } from "@/modules/stripe/stripe-payment-intents-api-factory";
import { transactionRecorder } from "@/modules/transactions-recording/repositories/transaction-recorder-impl";

import { withRecipientVerification } from "../with-recipient-verification";
import { withRequestDeduplication } from "../with-request-deduplication";
import { TransactionInitializeSessionUseCase } from "./use-case";
import { transactionInitializeSessionWebhookDefinition } from "./webhook-definition";

const useCase = new TransactionInitializeSessionUseCase({
  appConfigRepo: appConfigRepoImpl,
  stripePaymentIntentsApiFactory: new StripePaymentIntentsApiFactory(),
  transactionRecorder: transactionRecorder,
  // The amount charged is read from the checkout with the app token (NR-31).
  apl: saleorApp.apl,
  checkoutPaymentStateFetcherFactory: (authData) =>
    new CheckoutPaymentStateFetcher(
      createInstrumentedGraphqlClient({
        // The APL's https-enforced URL, so the app token never goes out over plain http.
        saleorApiUrl: authData.saleorApiUrl,
        token: authData.token,
      }),
    ),
  // PayPal-fee hard gate (A3c): from PAYMENT_FEE_GATE & co, validated when env.ts loaded.
  paymentFeeGate: paymentFeeGateFromEnv(env),
});

const logger = createLogger("TRANSACTION_INITIALIZE_SESSION route");

const handler = transactionInitializeSessionWebhookDefinition.createHandler(
  withRecipientVerification(
    withRequestDeduplication(async (_req, ctx) => {
      try {
        setObservabilitySourceObjectId(ctx.payload.sourceObject);

        loggerContext.set(
          ObservabilityAttributes.TRANSACTION_AMOUNT,
          ctx.payload.action.amount ?? null,
        );

        logger.info("Received webhook request");

        const saleorApiUrlResult = createSaleorApiUrl(ctx.authData.saleorApiUrl);

        if (saleorApiUrlResult.isErr()) {
          captureException(saleorApiUrlResult.error);
          const response = new MalformedRequestResponse(
            appContextContainer.getContextValue(),
            saleorApiUrlResult.error,
          );

          return response.getResponse();
        }

        setObservabilitySaleorApiUrl(saleorApiUrlResult.value, ctx.payload.version);

        const result = await useCase.execute({
          appId: ctx.authData.appId,
          saleorApiUrl: saleorApiUrlResult.value,
          event: ctx.payload,
        });

        return result.match(
          (result) => {
            logger.info("Successfully processed webhook request", {
              httpsStatusCode: result.statusCode,
              resolvedEvent: result.transactionResult.result,
              // todo: would be good to print stripeEnv here as well, but it's not available
            });

            return result.getResponse();
          },
          (err) => {
            logger.warn("Failed to process webhook request", {
              httpsStatusCode: err.statusCode,
              reason: err.message,
            });

            return err.getResponse();
          },
        );
      } catch (error) {
        captureException(error);
        logger.error("Unhandled error", { error: error });

        const response = new UnhandledErrorResponse(
          appContextContainer.getContextValue(),
          BaseError.normalize(error),
        );

        return response.getResponse();
      }
    }),
  ),
);

export const POST = compose(
  withLoggerContext,
  appContextContainer.wrapRequest,
  withSpanAttributesAppRouter,
)(handler);
