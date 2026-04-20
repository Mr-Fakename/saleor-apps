import { createManifestHandler } from "@saleor/app-sdk/handlers/next-app-router";
import { AppManifest } from "@saleor/app-sdk/types";
import { withSpanAttributesAppRouter } from "@saleor/apps-otel/src/with-span-attributes";
import { compose } from "@saleor/apps-shared/compose";

import { env } from "@/lib/env";
import { withLoggerContext } from "@/lib/logger-context";
import packageJson from "@/package.json";

const handler = createManifestHandler({
  async manifestFactory({ appBaseUrl }) {
    const iframeBaseUrl = env.APP_IFRAME_BASE_URL ?? appBaseUrl;
    const apiBaseUrl = env.APP_API_BASE_URL ?? appBaseUrl;

    const manifest: AppManifest = {
      about:
        "App that extends customer capabilities with wishlists and verified product reviews.",
      appUrl: iframeBaseUrl,
      author: "Daybreak Development",
      brand: {
        logo: {
          default: `${apiBaseUrl}/logo.png`,
        },
      },
      extensions: [],
      id: env.MANIFEST_APP_ID,
      /**
       * Can set custom name, e.g. in Development to recognize the app
       */
      name: env.APP_NAME,
      permissions: ["MANAGE_USERS", "MANAGE_ORDERS"],
      requiredSaleorVersion: ">=3.21 <4",
      tokenTargetUrl: `${apiBaseUrl}/api/register`,
      version: packageJson.version,
      webhooks: [
        // TODO: Add webhook definitions here if needed
      ],
    };

    return manifest;
  },
});

export const GET = compose(withLoggerContext, withSpanAttributesAppRouter)(handler);
