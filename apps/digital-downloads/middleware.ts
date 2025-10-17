import { NextRequest, NextResponse } from "next/server";

/**
 * Next.js middleware that enforces HTTPS protocol in Saleor webhook headers
 *
 * This fixes the HTTP/HTTPS inconsistency issue where Saleor sends webhooks with HTTP URLs
 * in the `saleor-api-url` header, causing signature verification to fail.
 *
 * The middleware intercepts incoming webhook requests and ensures the `saleor-api-url` header
 * uses HTTPS protocol before the SDK processes the request.
 */
export function middleware(request: NextRequest) {
  // Only process webhook requests
  if (!request.nextUrl.pathname.startsWith("/api/webhooks/saleor/")) {
    return NextResponse.next();
  }

  const saleorApiUrl = request.headers.get("saleor-api-url");

  // If no saleor-api-url header or already HTTPS, pass through
  if (!saleorApiUrl || saleorApiUrl.startsWith("https://")) {
    return NextResponse.next();
  }

  // Enforce HTTPS by replacing http:// with https://
  const httpsUrl = saleorApiUrl.replace(/^http:\/\//, "https://");

  // Create a new request with modified headers
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("saleor-api-url", httpsUrl);

  // Log the URL conversion for debugging
  console.log("[HTTPS Middleware] Converted saleor-api-url header:", {
    original: saleorApiUrl,
    enforced: httpsUrl,
    path: request.nextUrl.pathname,
  });

  // Create a new response with the modified headers
  // Note: We need to pass the modified headers through the request
  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  return response;
}

/**
 * Configure which routes the middleware should run on
 * Only run on Saleor webhook endpoints
 */
export const config = {
  matcher: "/api/webhooks/saleor/:path*",
};
