import { createManifestHandler } from "@saleor/app-sdk/handlers/next";
import { AppManifest } from "@saleor/app-sdk/types";
import { wrapWithLoggerContext } from "@saleor/apps-logger/node";
import { withSpanAttributes } from "@saleor/apps-otel/src/with-span-attributes";

import packageJson from "../../../package.json";
import { createLogger } from "../../logger";
import { loggerContext } from "../../logger-context";

export default wrapWithLoggerContext(
  withSpanAttributes(
    createManifestHandler({
      async manifestFactory({ appBaseUrl }) {
        const iframeBaseUrl = process.env.APP_IFRAME_BASE_URL ?? appBaseUrl;
        const apiBaseURL = process.env.APP_API_BASE_URL ?? appBaseUrl;

        const logger = createLogger("manifestFactory");

        logger.info("Generating manifest");

        const manifest: AppManifest = {
          about: "Generate feeds consumed by Merchant Platforms",
          appUrl: iframeBaseUrl,
          author: "Daybreak Development",
          brand: {
            logo: {
              default: `${apiBaseURL}/logo.png`,
            },
          },
          extensions: [],
          id: "saleor.app.product-feed",
          name: "Product Feed",
          permissions: ["MANAGE_PRODUCTS"],
          tokenTargetUrl: `${apiBaseURL}/api/register`,
          version: packageJson.version,
          webhooks: [],
        };

        return manifest;
      },
    }),
  ),
  loggerContext,
);
