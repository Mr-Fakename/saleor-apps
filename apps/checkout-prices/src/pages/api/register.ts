import { createAppRegisterHandler } from "@saleor/app-sdk/handlers/next";
import type { NextApiRequest, NextApiResponse } from "next";

import { saleorApp } from "../../saleor-app";

const allowedUrlsPattern = process.env.ALLOWED_DOMAIN_PATTERN;

/**
 * Required endpoint, called by Saleor to install app.
 * It will exchange tokens with app, so saleorApp.apl will contain token
 */
const baseHandler = createAppRegisterHandler({
  apl: saleorApp.apl,
  allowedSaleorUrls: [
    (url) => {
      console.log("[REGISTER] Checking if URL is allowed:", url);

      if (allowedUrlsPattern) {
        const regex = new RegExp(allowedUrlsPattern);
        const isAllowed = regex.test(url);
        console.log(`[REGISTER] Pattern: ${allowedUrlsPattern}, Match: ${isAllowed}`);
        return isAllowed;
      }

      console.log("[REGISTER] No pattern set, allowing all URLs");
      return true;
    },
  ],
  async onRequestVerified(req, { authData: { token, saleorApiUrl }, respondWithError }) {
    console.log("[REGISTER] onRequestVerified called");
    console.log("[REGISTER] Saleor API URL:", saleorApiUrl);
    console.log("[REGISTER] Token received:", token ? "Yes (length: " + token.length + ")" : "No");

    try {
      // Test connection to Saleor API
      console.log("[REGISTER] Testing connection to Saleor API...");

      const response = await fetch(saleorApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization-Bearer": token,
        },
        body: JSON.stringify({
          query: `
            query {
              shop {
                name
                version
              }
            }
          `,
        }),
      });

      console.log("[REGISTER] Saleor API response status:", response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[REGISTER] Saleor API error response:", errorText);
        throw new Error(`Failed to connect to Saleor API: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.log("[REGISTER] Shop info:", JSON.stringify(data, null, 2));

      if (data.errors) {
        console.error("[REGISTER] GraphQL errors:", JSON.stringify(data.errors, null, 2));
        throw new Error("GraphQL errors: " + JSON.stringify(data.errors));
      }

      console.log("[REGISTER] ✓ Successfully connected to Saleor API");
      console.log("[REGISTER] Shop name:", data.data?.shop?.name);
      console.log("[REGISTER] Saleor version:", data.data?.shop?.version);

    } catch (e: unknown) {
      const message = (e as Error)?.message ?? "Unknown error";
      console.error("[REGISTER] ✗ Error during Saleor API connection test:", message);
      console.error("[REGISTER] Full error:", e);

      throw respondWithError({
        message: `Couldn't connect to Saleor API at ${saleorApiUrl}. Error: ${message}`,
        status: 400,
      });
    }

    try {
      console.log("[REGISTER] Saving auth data to APL...");
      // The SDK's handler will automatically call apl.set(authData) after onRequestVerified returns.
      // We don't need to do anything here, but we'll log it to confirm we reached this point.
      console.log("[REGISTER] ✓ Registration verification completed successfully");
    } catch (e: unknown) {
      console.error("[REGISTER] ✗ Error during auth data persistence:", e);
      throw e;
    }
  },
});

/**
 * Wrapper handler that enforces HTTPS on the saleor-api-url header
 * This follows the pattern from the Stripe app
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log("[REGISTER] Handler called");
  console.log("[REGISTER] Original headers:", JSON.stringify(req.headers, null, 2));

  // Get the saleor-domain header (just the domain, no protocol)
  const saleorDomain = req.headers["saleor-domain"];

  if (saleorDomain && typeof saleorDomain === "string") {
    // Construct HTTPS URL from domain
    const newApiUrl = `https://${saleorDomain}/graphql/`;

    console.log("[REGISTER] Found saleor-domain header:", saleorDomain);
    console.log("[REGISTER] Enforcing HTTPS - New API URL:", newApiUrl);

    // Modify the saleor-api-url header to use HTTPS
    req.headers["saleor-api-url"] = newApiUrl;
  } else {
    console.log("[REGISTER] No saleor-domain header found");

    // Fallback: if saleor-api-url exists, convert it to HTTPS
    const saleorApiUrl = req.headers["saleor-api-url"];
    if (saleorApiUrl && typeof saleorApiUrl === "string") {
      const httpsUrl = saleorApiUrl.replace(/^http:\/\//, "https://");
      if (httpsUrl !== saleorApiUrl) {
        console.log("[REGISTER] Converting saleor-api-url from HTTP to HTTPS");
        console.log("[REGISTER] Original:", saleorApiUrl);
        console.log("[REGISTER] New:", httpsUrl);
        req.headers["saleor-api-url"] = httpsUrl;
      }
    }
  }

  console.log("[REGISTER] Modified headers:", JSON.stringify(req.headers, null, 2));

  // Call the base handler with modified request
  return baseHandler(req, res);
}
