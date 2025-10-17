import { withSpanAttributesAppRouter } from "@saleor/apps-otel/src/with-span-attributes";
import { compose } from "@saleor/apps-shared/compose";
import { captureException } from "@sentry/nextjs";

import {
  MalformedRequestResponse,
  UnhandledErrorResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import { appContextContainer } from "@/lib/app-context";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { withLoggerContext } from "@/lib/logger-context";
import { setObservabilitySaleorApiUrl } from "@/lib/observability-saleor-api-url";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { withHttpsHeaders } from "../with-https-headers";
import { withRecipientVerification } from "../with-recipient-verification";
import { orderFullyPaidUseCase } from "./use-case";
import { orderFullyPaidWebhookDefinition } from "./webhook-definition";

const logger = createLogger("ORDER_FULLY_PAID route");

const handler = orderFullyPaidWebhookDefinition.createHandler(
  withRecipientVerification(async (_req, ctx) => {
    try {
      logger.info("Received ORDER_FULLY_PAID webhook request", {
        orderId: ctx.payload.order?.id,
        orderNumber: ctx.payload.order?.number,
        authDataSaleorApiUrl: ctx.authData.saleorApiUrl,
        authDataAppId: ctx.authData.appId,
      });

      const saleorApiUrlResult = createSaleorApiUrl(ctx.authData.saleorApiUrl);

      if (saleorApiUrlResult.isErr()) {
        const response = new MalformedRequestResponse(
          appContextContainer.getContextValue(),
          saleorApiUrlResult.error,
        );

        captureException(saleorApiUrlResult.error);

        return response.getResponse();
      }

      setObservabilitySaleorApiUrl(saleorApiUrlResult.value);

      const result = await orderFullyPaidUseCase.execute({
        payload: ctx.payload,
      });

      return result.match(
        (result) => {
          logger.info("Successfully processed ORDER_FULLY_PAID webhook", {
            tokensCreated: result.tokensCreated,
          });

          return Response.json(
            {
              message: "Download tokens created successfully",
              tokensCreated: result.tokensCreated,
            },
            { status: 200 },
          );
        },
        (error) => {
          logger.warn("Failed to process ORDER_FULLY_PAID webhook", {
            error: error.message,
          });

          // Return success even if no digital items found
          // This is not an error case for the webhook
          return Response.json(
            {
              message: error.message,
            },
            { status: 200 },
          );
        },
      );
    } catch (error) {
      captureException(error);
      logger.error("Unhandled error in ORDER_FULLY_PAID webhook", { error });

      const response = new UnhandledErrorResponse(
        appContextContainer.getContextValue(),
        BaseError.normalize(error),
      );

      return response.getResponse();
    }
  }),
);

export const POST = compose(
  withLoggerContext,
  appContextContainer.wrapRequest,
  withSpanAttributesAppRouter,
  withHttpsHeaders,
)(handler);
