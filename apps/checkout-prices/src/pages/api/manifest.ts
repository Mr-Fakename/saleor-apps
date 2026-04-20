import { createManifestHandler } from "@saleor/app-sdk/handlers/next";
import { AppManifest } from "@saleor/app-sdk/types";

import packageJson from "../../../package.json";

/**
 * App SDK helps with the valid Saleor App Manifest creation. Read more:
 * https://github.com/saleor/saleor-app-sdk/blob/main/docs/api-handlers.md#manifest-handler-factory
 */
export default createManifestHandler({
  async manifestFactory({ appBaseUrl, request }) {
    console.log("[MANIFEST] Generating manifest");
    console.log("[MANIFEST] appBaseUrl from request:", appBaseUrl);
    console.log("[MANIFEST] APP_IFRAME_BASE_URL env:", process.env.APP_IFRAME_BASE_URL);
    console.log("[MANIFEST] APP_API_BASE_URL env:", process.env.APP_API_BASE_URL);

    /**
     * Allow to overwrite default app base url, to enable Docker support.
     * Always prefer environment variables over the appBaseUrl from request.
     * Enforce HTTPS if using the request's appBaseUrl as fallback.
     */
    let iframeBaseUrl = process.env.APP_IFRAME_BASE_URL ?? appBaseUrl;
    let apiBaseURL = process.env.APP_API_BASE_URL ?? appBaseUrl;

    // Enforce HTTPS on fallback URLs
    if (!process.env.APP_IFRAME_BASE_URL) {
      iframeBaseUrl = iframeBaseUrl.replace(/^http:\/\//, "https://");
      console.log("[MANIFEST] No APP_IFRAME_BASE_URL env, enforcing HTTPS on request URL");
    }

    if (!process.env.APP_API_BASE_URL) {
      apiBaseURL = apiBaseURL.replace(/^http:\/\//, "https://");
      console.log("[MANIFEST] No APP_API_BASE_URL env, enforcing HTTPS on request URL");
    }

    console.log("[MANIFEST] Final iframeBaseUrl:", iframeBaseUrl);
    console.log("[MANIFEST] Final apiBaseURL:", apiBaseURL);
    console.log("[MANIFEST] tokenTargetUrl:", `${apiBaseURL}/api/register`);

    const manifest: AppManifest = {
      name: "Checkout Prices",
      tokenTargetUrl: `${apiBaseURL}/api/register`,
      appUrl: iframeBaseUrl,
      /**
       * Set permissions for app if needed
       * https://docs.saleor.io/docs/3.x/developer/permissions
       */
      permissions: [
        /**
         * Add permission to allow "ORDER_CREATED" webhook registration.
         *
         * This can be removed
         */
        "MANAGE_ORDERS",
        "MANAGE_CHECKOUTS",
        "MANAGE_PRODUCTS",
        "HANDLE_CHECKOUTS",
      ],
      id: "saleor.app.checkout-prices",
      version: packageJson.version,
      /**
       * Configure webhooks here. They will be created in Saleor during installation
       * Read more
       * https://docs.saleor.io/docs/3.x/developer/api-reference/webhooks/objects/webhook
       *
       * Easiest way to create webhook is to use app-sdk
       * https://github.com/saleor/saleor-app-sdk/blob/main/docs/saleor-webhook.md
       */
      webhooks: [],
      /**
       * Optionally, extend Dashboard with custom UIs
       * https://docs.saleor.io/docs/3.x/developer/extending/apps/extending-dashboard-with-apps
       */
      extensions: [],
      author: "Daybreak Development",
      brand: {
        logo: {
          default: `${apiBaseURL}/logo.png`,
        },
      },
    };

    return manifest;
  },
});
