import { z } from "zod";

import { config } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import { protectedDashboardProcedure } from "@/modules/trpc/protected-dashboard-procedure";

const logger = createLogger("GetFeatureConfigTrpcHandler");

const outputSchema = z.object({
  requireOrderUnlockForReviews: z.boolean(),
});

export class GetFeatureConfigTrpcHandler {
  getTrpcProcedure() {
    return protectedDashboardProcedure.output(outputSchema).query(async ({ ctx }) => {
      logger.debug("GetFeatureConfig called", {
        saleorApiUrl: ctx.saleorApiUrl,
      });

      return {
        requireOrderUnlockForReviews: config.requireOrderUnlockForReviews,
      };
    });
  }
}
