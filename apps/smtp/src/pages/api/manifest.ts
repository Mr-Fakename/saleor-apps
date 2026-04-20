import { createManifestHandler } from "@saleor/app-sdk/handlers/next";
import { AppManifest } from "@saleor/app-sdk/types";
import { withSpanAttributes } from "@saleor/apps-otel/src/with-span-attributes";

import packageJson from "../../../package.json";

export default withSpanAttributes(
  createManifestHandler({
    async manifestFactory({ appBaseUrl }) {
      const iframeBaseUrl = process.env.APP_IFRAME_BASE_URL ?? appBaseUrl;
      const apiBaseURL = process.env.APP_API_BASE_URL ?? appBaseUrl;

      const manifest: AppManifest = {
        about:
          "SMTP App that allows you to send transactional emails using your own SMTP server.",
        appUrl: iframeBaseUrl,
        author: "Daybreak Development",
        brand: {
          logo: {
            default: `${apiBaseURL}/logo.png`,
          },
        },
        extensions: [
          /**
           * Optionally, extend Dashboard with custom UIs
           * https://docs.saleor.io/developer/extending/apps/extending-dashboard-with-apps
           */
        ],
        id: "saleor.app.smtp",
        name: "SMTP",
        permissions: ["MANAGE_ORDERS", "MANAGE_USERS", "MANAGE_GIFT_CARD", "MANAGE_STAFF"],
        requiredSaleorVersion: ">=3.19 <4",
        tokenTargetUrl: `${apiBaseURL}/api/register`,
        version: packageJson.version,
      };

      return manifest;
    },
  }),
);
