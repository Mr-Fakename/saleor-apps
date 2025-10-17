import { createLogger } from "./logger";

const logger = createLogger("HttpsFetchWrapper");

/**
 * Global fetch wrapper that enforces HTTPS for Saleor API requests
 *
 * This intercepts all fetch calls and replaces HTTP URLs with HTTPS URLs
 * for Saleor API domains, specifically for JWKS fetching.
 */
const originalFetch = global.fetch;

global.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let url: string;

  if (typeof input === "string") {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else if (input instanceof Request) {
    url = input.url;
  } else {
    url = String(input);
  }

  // Check if this is a Saleor API request (contains /graphql/ or /.well-known/jwks.json)
  const isSaleorRequest = url.includes("/graphql/") || url.includes("/.well-known/jwks.json");

  if (isSaleorRequest && url.startsWith("http://")) {
    const httpsUrl = url.replace(/^http:\/\//, "https://");

    logger.debug("Fetch wrapper: Converting HTTP to HTTPS", {
      originalUrl: url,
      httpsUrl,
      isJwksRequest: url.includes("/.well-known/jwks.json"),
    });

    // Create new input with HTTPS URL
    if (typeof input === "string") {
      return originalFetch(httpsUrl, init);
    } else if (input instanceof URL) {
      return originalFetch(new URL(httpsUrl), init);
    } else if (input instanceof Request) {
      // Create a new Request with the HTTPS URL
      const newRequest = new Request(httpsUrl, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        mode: input.mode,
        credentials: input.credentials,
        cache: input.cache,
        redirect: input.redirect,
        referrer: input.referrer,
        integrity: input.integrity,
        ...init,
      });
      return originalFetch(newRequest);
    }
  }

  // Pass through non-Saleor requests or already-HTTPS requests
  return originalFetch(input, init);
} as typeof fetch;

logger.info("Global fetch wrapper installed for HTTPS enforcement");
