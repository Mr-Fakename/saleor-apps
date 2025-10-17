import { createLogger } from "@/lib/logger";

const logger = createLogger("withHttpsHeaders");

/**
 * Middleware wrapper that enforces HTTPS URLs in request headers
 *
 * This is critical for webhook signature verification to work correctly.
 * Saleor sometimes sends webhooks with HTTP URLs in headers, but the JWT
 * signature verification expects HTTPS URLs to match the registered app URL.
 *
 * This wrapper intercepts the request and creates a new Request object with
 * modified headers, converting any HTTP URLs to HTTPS before they reach the SDK.
 */
export function withHttpsHeaders<T extends (...args: any[]) => any>(handler: T): T {
  return (async (request: Request, ...rest: any[]) => {
    const originalHeaders = request.headers;
    const saleorApiUrl = originalHeaders.get("saleor-api-url");
    const saleorDomain = originalHeaders.get("saleor-domain");

    logger.debug("withHttpsHeaders: Processing request", {
      originalSaleorApiUrl: saleorApiUrl,
      originalSaleorDomain: saleorDomain,
      isHttp: saleorApiUrl?.startsWith("http://"),
    });

    // Check if we need to modify headers
    if (saleorApiUrl?.startsWith("http://") || saleorDomain?.startsWith("http://")) {
      // Create new headers with HTTPS URLs
      const newHeaders = new Headers(originalHeaders);

      if (saleorApiUrl?.startsWith("http://")) {
        const httpsUrl = saleorApiUrl.replace(/^http:\/\//, "https://");
        newHeaders.set("saleor-api-url", httpsUrl);

        logger.debug("withHttpsHeaders: Converted saleor-api-url header", {
          from: saleorApiUrl,
          to: httpsUrl,
        });
      }

      if (saleorDomain?.startsWith("http://")) {
        const httpsDomain = saleorDomain.replace(/^http:\/\//, "https://");
        newHeaders.set("saleor-domain", httpsDomain);

        logger.debug("withHttpsHeaders: Converted saleor-domain header", {
          from: saleorDomain,
          to: httpsDomain,
        });
      }

      // Create a new Request object with modified headers
      // We need to clone the request body if it exists
      const newRequest = new Request(request.url, {
        method: request.method,
        headers: newHeaders,
        body: request.body,
        // @ts-expect-error - duplex is required for body streaming but not in types
        duplex: "half",
      });

      logger.debug("withHttpsHeaders: Created new request with HTTPS headers");

      return handler(newRequest, ...rest);
    }

    logger.debug("withHttpsHeaders: No header modification needed");

    // No modification needed, pass through original request
    return handler(request, ...rest);
  }) as T;
}
