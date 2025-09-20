import { NextAppRouterSyncWebhookHandler } from "@saleor/app-sdk/handlers/next-app-router";
import { WebhookContext } from "@saleor/app-sdk/handlers/shared";
import { NextRequest } from "next/server";

import { EventMetadataFragment } from "@/generated/graphql";
import { createLogger } from "@/lib/logger";

type PayloadPartial = Pick<EventMetadataFragment, "recipient">;

const logger = createLogger("withRecipientVerification");

export function withRecipientVerification<Payload extends PayloadPartial>(
  handler: NextAppRouterSyncWebhookHandler<Payload>,
) {
  return async (req: NextRequest, ctx: WebhookContext<Payload>) => {
    const authDataId = ctx.authData.appId;
    const recipientId = ctx.payload.recipient?.id;

    logger.debug("=== RECIPIENT VERIFICATION DEBUG: Checking recipient ===", {
      authDataAppId: authDataId,
      payloadRecipientId: recipientId,
      hasRecipient: !!ctx.payload.recipient,
      match: authDataId === recipientId,
    });

    if (authDataId !== recipientId) {
      logger.error("=== RECIPIENT VERIFICATION DEBUG: Recipient ID mismatch ===", {
        authDataAppId: authDataId,
        payloadRecipientId: recipientId,
        status: 403,
        message: "Recipient ID does not match auth data ID",
      });

      return Response.json(
        { message: "Recipient ID does not match auth data ID" },
        { status: 403 },
      );
    }

    logger.debug("=== RECIPIENT VERIFICATION DEBUG: Recipient verification passed ===", {
      authDataAppId: authDataId,
      payloadRecipientId: recipientId,
    });

    return handler(req, ctx);
  };
}
