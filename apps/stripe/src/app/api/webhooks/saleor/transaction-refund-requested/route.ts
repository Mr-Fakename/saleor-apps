import { ObservabilityAttributes } from "@saleor/apps-otel/src/observability-attributes";
import { withSpanAttributesAppRouter } from "@saleor/apps-otel/src/with-span-attributes";
import { compose } from "@saleor/apps-shared/compose";
import { captureException } from "@sentry/nextjs";
import { NextRequest } from "next/server";

import {
  MalformedRequestResponse,
  UnhandledErrorResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import { appContextContainer } from "@/lib/app-context";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { loggerContext, withLoggerContext } from "@/lib/logger-context";
import { setObservabilitySaleorApiUrl } from "@/lib/observability-saleor-api-url";
import { setObservabilitySourceObjectId } from "@/lib/observability-source-object-id";
import { appConfigRepoImpl } from "@/modules/app-config/repositories/app-config-repo-impl";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { StripeRefundsApiFactory } from "@/modules/stripe/stripe-refunds-api-factory";

import { withRecipientVerification } from "../with-recipient-verification";
import { TransactionRefundRequestedUseCase } from "./use-case";
import { transactionRefundRequestedWebhookDefinition } from "./webhook-definition";

const useCase = new TransactionRefundRequestedUseCase({
  appConfigRepo: appConfigRepoImpl,
  stripeRefundsApiFactory: new StripeRefundsApiFactory(),
});

const logger = createLogger("TRANSACTION_REFUND_REQUESTED route");

const innerHandler = withRecipientVerification(async (req, ctx) => {
  try {
    try {
      setObservabilitySourceObjectId({
        __typename: (ctx.payload as any).transaction?.checkout?.id ? "Checkout" : "Order",
        id:
          (ctx.payload as any).transaction?.checkout?.id ??
          (ctx.payload as any).transaction?.order?.id ??
          null,
      });

      loggerContext.set(
        ObservabilityAttributes.PSP_REFERENCE,
        (ctx.payload as any).transaction?.pspReference ?? null,
      );

      loggerContext.set(
        ObservabilityAttributes.TRANSACTION_AMOUNT,
        (ctx.payload as any).action?.amount ?? null,
      );

      logger.info("Processing refund webhook", {
        transactionId: (ctx.payload as any).transaction?.id,
        pspReference: (ctx.payload as any).transaction?.pspReference,
        amount: (ctx.payload as any).action?.amount,
      });

      const saleorApiUrlResult = createSaleorApiUrl(ctx.authData.saleorApiUrl);

      if (saleorApiUrlResult.isErr()) {
        logger.error("Saleor API URL validation failed", {
          error: saleorApiUrlResult.error.message,
        });
        captureException(saleorApiUrlResult.error);
        const response = new MalformedRequestResponse(
          appContextContainer.getContextValue(),
          saleorApiUrlResult.error,
        );

        return response.getResponse();
      }

      setObservabilitySaleorApiUrl(saleorApiUrlResult.value, (ctx.payload as any).version);

      const result = await useCase.execute({
        appId: ctx.authData.appId,
        saleorApiUrl: saleorApiUrlResult.value,
        event: ctx.payload as any,
      });

      return result.match(
        (result) => {
          logger.info("Refund webhook processed successfully", {
            statusCode: result.statusCode,
            stripeRefundId: "stripeRefundId" in result ? result.stripeRefundId : undefined,
          });

          return result.getResponse();
        },
        (err) => {
          logger.error("Refund webhook processing failed", {
            statusCode: err.statusCode,
            error: err.message,
          });

          return err.getResponse();
        },
      );
    } catch (error) {
      captureException(error);
      logger.error("Unhandled error in refund webhook handler", {
        error: error instanceof Error ? error.message : String(error),
      });
      const response = new UnhandledErrorResponse(
        appContextContainer.getContextValue(),
        BaseError.normalize(error),
      );

      return response.getResponse();
    }
  } catch (outerError) {
    logger.error("Critical error in refund webhook wrapper", {
      error: outerError instanceof Error ? outerError.message : String(outerError),
    });
    throw outerError;
  }
});

const handler = transactionRefundRequestedWebhookDefinition.createHandler(innerHandler);

export const POST = compose(
  withLoggerContext,
  appContextContainer.wrapRequest,
  withSpanAttributesAppRouter,
)(handler);
