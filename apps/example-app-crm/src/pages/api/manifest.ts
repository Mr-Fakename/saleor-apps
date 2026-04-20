import { createManifestHandler } from "@saleor/app-sdk/handlers/next";
import { AppManifest } from "@saleor/app-sdk/types";

import { wrapWithLoggerContext } from "../../logger-context";
import packageJson from "../../../package.json";
import { loggerContext } from "../../logger-context";
import { customerCreatedWebhook } from "./webhooks/customer-created";
import { customerMetadataUpdatedWebhook } from "./webhooks/customer-updated";

export default wrapWithLoggerContext(
  createManifestHandler({
    async manifestFactory({ appBaseUrl }) {
      const iframeBaseUrl = process.env.APP_IFRAME_BASE_URL ?? appBaseUrl;
      const apiBaseURL = process.env.APP_API_BASE_URL ?? appBaseUrl;

      const manifest: AppManifest = {
        about: "CRM App allows synchronization of customers from Saleor to other platforms",
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
           * https://docs.saleor.io/docs/3.x/developer/extending/apps/extending-dashboard-with-apps
           */
        ],
        id: "saleor.app.crm",
        name: "CRM",
        permissions: [
          "MANAGE_USERS",
          /**
           * Set permissions for app if needed
           * https://docs.saleor.io/docs/3.x/developer/permissions
           */
        ],
        tokenTargetUrl: `${apiBaseURL}/api/register`,
        version: packageJson.version,
        webhooks: [
          customerCreatedWebhook.getWebhookManifest(apiBaseURL),
          customerMetadataUpdatedWebhook.getWebhookManifest(apiBaseURL),
        ],
      };

      return manifest;
    },
  }),
  loggerContext,
);
