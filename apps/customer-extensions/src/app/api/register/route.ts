import { createAppRegisterHandler } from "@saleor/app-sdk/handlers/next-app-router";
import { withSpanAttributesAppRouter } from "@saleor/apps-otel/src/with-span-attributes";
import { compose } from "@saleor/apps-shared/compose";
import { NextRequest } from "next/server";

import { env } from "@/lib/env";
import { withLoggerContext } from "@/lib/logger-context";
import { saleorApp } from "@/lib/saleor-app";

const allowedUrlsPattern = env.ALLOWED_DOMAIN_PATTERN;

const baseHandler = createAppRegisterHandler({
  apl: saleorApp.apl,
  /**
   * Prohibit installation from Saleor other than specified by the regex.
   * Regex source is ENV so if ENV is not set, all installations will be allowed.
   */
  allowedSaleorUrls: [
    (url) => {
      if (allowedUrlsPattern) {
        // we don't escape the pattern because it's not user input - it's an ENV variable controlled by us
        const regex = new RegExp(allowedUrlsPattern);

        return regex.test(url);
      }

      return true;
    },
  ],
});

async function handler(req: NextRequest) {
  // Read the request body
  const bodyText = await req.text();

  // Clone and modify headers
  const headers = new Headers(req.headers);
  const saleorDomain = headers.get("saleor-domain");

  if (saleorDomain) {
    const newApiUrl = `https://${saleorDomain}/graphql/`;

    headers.set("saleor-api-url", newApiUrl);
  }

  const rebuiltReq = new NextRequest(req.url, {
    method: req.method,
    headers,
    body: bodyText,
  });

  return baseHandler(rebuiltReq);
}

export const POST = compose(withLoggerContext, withSpanAttributesAppRouter)(handler);
