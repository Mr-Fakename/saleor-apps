# Digital Downloads Webhook HTTP/HTTPS URL Inconsistency Fix

## Problem Summary

The Digital Downloads app webhooks were failing with authentication errors (HTTP 401 - SIGNATURE_VERIFICATION_FAILED). The root cause is:

**Saleor is delivering webhooks with HTTP protocol in headers when HTTPS is expected:**
- Some webhooks receive HTTPS URLs in the `saleor-api-url` header
- Other webhooks (like ORDER_FULLY_PAID) receive HTTP URLs in headers
- This inconsistency causes signature verification to fail

This inconsistency causes signature verification failures because:
1. Authentication data is stored with HTTPS URLs during app installation
2. Webhooks arrive with HTTP URLs in the `saleor-api-url` header
3. The SDK fetches JWKS using the HTTP URL from headers, which may fail or return incompatible keys
4. Signature verification fails with "SIGNATURE_VERIFICATION_FAILED" error

## Dashboard Log Evidence

```
Failed delivery:
HTTP 401 Status: FAILED
{"error":{"type":"SIGNATURE_VERIFICATION_FAILED","message":"Request signature check failed"}}
```

## Solution Implemented

### 1. Request Header Transformation (PRIMARY FIX) - **FINAL SOLUTION**

**Created `src/app/api/webhooks/saleor/with-https-headers.ts`** - A middleware wrapper that intercepts incoming webhook requests and converts HTTP URLs to HTTPS in the request headers BEFORE the SDK reads them.

This is the critical fix because:
- The Saleor SDK extracts `saleorApiUrl` from the incoming request's `saleor-api-url` header
- The SDK reads these headers **before** any of our code (APL, fetch wrapper) runs
- The JWT signature verification uses the URL from headers, and it must match the HTTPS URL we registered
- By modifying the headers at the request level, we ensure the SDK sees HTTPS URLs from the start

The wrapper is applied via the `compose()` pattern in the route handler:
```typescript
export const POST = compose(
  withLoggerContext,
  appContextContainer.wrapRequest,
  withSpanAttributesAppRouter,
  withHttpsHeaders, // <-- This wrapper converts HTTP headers to HTTPS
)(handler);
```

### 2. Global Fetch Wrapper (SECONDARY FIX)

**Created `src/lib/https-fetch-wrapper.ts`** and imported it in **`instrumentation.ts` (at app root, NOT in src/)** to intercept ALL outgoing fetch requests (including SDK JWKS fetching) and enforce HTTPS.

**CRITICAL**: The instrumentation file MUST be at the app root (`/instrumentation.ts`), not in `src/`. Next.js only recognizes instrumentation files at the root level.

This is the critical fix that addresses the root cause:
- The SDK makes fetch requests to Saleor API to retrieve JWKS
- Even though `HttpsEnforcingAPL` normalizes auth data, the SDK constructs URLs from request headers for JWKS fetching
- The global fetch wrapper intercepts ALL fetch calls and converts Saleor API HTTP URLs to HTTPS

```typescript
// src/lib/https-fetch-wrapper.ts
const originalFetch = global.fetch;

global.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let url = extractUrl(input);

  // Check if this is a Saleor API request
  const isSaleorRequest = url.includes("/graphql/") || url.includes("/.well-known/jwks.json");

  if (isSaleorRequest && url.startsWith("http://")) {
    const httpsUrl = url.replace(/^http:\/\//, "https://");
    // Convert request to use HTTPS URL
    return originalFetch(httpsUrl, init);
  }

  return originalFetch(input, init);
} as typeof fetch;
```

```typescript
// instrumentation.ts (at app root, next to package.json)
export const register = async () => {
  // Install fetch wrapper FIRST
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./src/lib/https-fetch-wrapper");
  }
  // ... other instrumentations
};
```

### 3. Enhanced HttpsEnforcingAPL (Existing - Tertiary Fix)

Enhanced the existing `HttpsEnforcingAPL` class (`src/lib/https-enforcing-apl.ts`) with comprehensive fallback logic:

```typescript
async get(saleorApiUrl: string): Promise<AuthData | undefined> {
  // Try HTTPS first
  const httpsUrl = saleorApiUrl.replace(/^http:\/\//, "https://");
  let authData = await this.baseApl.get(httpsUrl);

  if (!authData) {
    // Fallback to HTTP
    const httpUrl = saleorApiUrl.replace(/^https:\/\//, "http://");
    authData = await this.baseApl.get(httpUrl);
  }

  // FALLBACK: Try original URL as-is
  if (!authData) {
    authData = await this.baseApl.get(saleorApiUrl);
  }

  return authData ? this.enforceHttps(authData) : undefined;
}
```

### 2. Comprehensive Debug Logging

Added extensive debug logging throughout the webhook flow to track:
- **APL operations** (`src/lib/https-enforcing-apl.ts`):
  - Logs every `get()` call with original URL and protocol detection
  - Shows which URL variant (HTTPS/HTTP/original) successfully finds auth data
  - Logs URL normalization showing before/after URLs
  - Logs `set()` operations showing URL enforcement
- **Webhook signature verification** (`src/app/api/webhooks/saleor/verify-signature.ts`):
  - Logs JWKS length, signature length, and body length
  - Logs verification success/failure with error details
- **Webhook handler** (`src/app/api/webhooks/saleor/order-fully-paid/route.ts`):
  - Logs incoming webhook with auth data details
  - Shows the normalized `saleorApiUrl` from auth data
- **Webhook definition** (`src/app/api/webhooks/saleor/order-fully-paid/webhook-definition.ts`):
  - Logs signature verification attempts at the definition level
  - Shows JWKS and signature availability

### 3. HTTPS JWKS Verifier

The app includes `httpsJwksVerifier` (`src/app/api/webhooks/saleor/https-jwks-verifier.ts`) that can be used if needed to force HTTPS JWKS fetching. Currently not integrated in the webhook definition, but available if the HttpsEnforcingAPL approach proves insufficient.

## Root Cause Analysis

The issue originates from Saleor's webhook delivery system inconsistently using HTTP vs HTTPS URLs for different webhook types. This appears to be a configuration issue at the Saleor level, not in the app code.

**Webhook registration shows all endpoints correctly defined:**
- All webhook definitions use identical relative paths: `"api/webhooks/saleor/transaction-refund-requested"`
- Manifest generation is consistent for all webhook types
- No environment variable or configuration differences found

## Verification

The enhanced APL system should now handle both HTTP and HTTPS URLs correctly:

1. **Authentication Lookup**: APL tries HTTPS first, then HTTP, then original URL
2. **URL Normalization**: All returned auth data uses HTTPS URLs
3. **Consistent Behavior**: Both HTTP and HTTPS webhook deliveries resolve to the same authentication data

## Testing & Verification

### 1. Enable Debug Logging

Set environment variable to enable all debug logs:
```bash
DEBUG=*
# or specifically for these components:
DEBUG=HttpsEnforcingAPL,verifyWebhookSignature,orderFullyPaidWebhookDefinition,ORDER_FULLY_PAID*
```

### 2. Re-deploy the App

**IMPORTANT**: The fix requires rebuilding the Docker image since the instrumentation file was moved to the app root.

```bash
# Rebuild the Docker image
docker compose build digital-downloads

# Or if using separate docker-compose for apps:
docker build -t digital-downloads-app saleor-apps/apps/digital-downloads/

# Then restart the container
docker compose up -d digital-downloads
```

### 3. Test the Webhook

1. **Trigger an ORDER_FULLY_PAID webhook**:
   - Create a product with digital file attributes (PDF, image, etc.)
   - Complete a test purchase
   - Mark the order as fully paid

2. **Check the logs** for these key indicators:
   ```
   [HttpsEnforcingAPL] APL get() called - shows original URL and protocol
   [HttpsEnforcingAPL] APL authentication data found and normalized - confirms URL conversion
   [orderFullyPaidWebhookDefinition] ORDER_FULLY_PAID webhook signature verification started
   [verifyWebhookSignature] Verifying webhook signature
   [verifyWebhookSignature] Webhook signature verification succeeded
   [ORDER_FULLY_PAID route] Received ORDER_FULLY_PAID webhook request
   [ORDER_FULLY_PAID route] Successfully processed ORDER_FULLY_PAID webhook
   ```

3. **Check Saleor Dashboard**:
   - Navigate to Apps → Digital Downloads → Webhooks
   - Look for successful deliveries (HTTP 200)
   - If failures persist, examine the error messages

### 4. Verify Customer Experience

- Customer should receive email with download access
- Download tokens should be created in the database
- Files should be accessible through the download links

## Next Steps

### Immediate Actions

1. **Monitor Production Logs**: Watch for the debug log entries after deployment
2. **Test Purchase Flow**: Complete end-to-end test of digital product purchase
3. **Verify Webhook Success**: Check Dashboard for HTTP 200 responses

### If Issues Persist

If webhooks still fail after implementing these changes:

1. **Check APL Storage**:
   - The app may need to be **uninstalled and reinstalled** to clear stale auth data
   - Old auth data stored with HTTP URLs may cause conflicts

2. **Verify HTTPS Accessibility**:
   - Ensure `https://your-saleor-domain/.well-known/jwks.json` is accessible from your app server
   - Test: `curl https://your-saleor-domain/.well-known/jwks.json`

3. **Check Network Configuration**:
   - Verify no firewall rules blocking HTTPS requests from app to Saleor
   - Check if reverse proxy/load balancer is modifying headers

4. **Review Saleor Configuration**:
   - Check if Saleor is configured with correct HTTPS URLs
   - Verify SSL/TLS certificates are valid

## Files Modified

**New Files:**
- `src/app/api/webhooks/saleor/with-https-headers.ts` - **PRIMARY FIX**: Request middleware that transforms HTTP headers to HTTPS before the SDK reads them
- `src/lib/https-fetch-wrapper.ts` - **SECONDARY FIX**: Global fetch wrapper that enforces HTTPS on all Saleor API requests
- `instrumentation.ts` - **CRITICAL**: Created at app root (not in src/) to load the fetch wrapper during app initialization. Next.js only recognizes this file when it's at the root level.

**Enhanced Files:**
- `src/app/api/webhooks/saleor/order-fully-paid/route.ts` - **CRITICAL**: Added `withHttpsHeaders` wrapper to the compose chain
- `src/lib/https-enforcing-apl.ts` - Enhanced with comprehensive debug logging for all APL operations
- `src/lib/saleor-app.ts` - Already uses HttpsEnforcingAPL wrapper (no changes needed)
- `src/app/api/webhooks/saleor/verify-signature.ts` - Enhanced with debug logging
- `src/app/api/webhooks/saleor/order-fully-paid/webhook-definition.ts` - Added signature verification logging
- `src/app/api/webhooks/saleor/with-recipient-verification.ts` - Already has debug logging (no changes needed)

## Key Insight: Why Request Header Transformation is Necessary

Neither the `HttpsEnforcingAPL` wrapper nor the global fetch wrapper were sufficient because:

1. **SDK Header Processing**: The Saleor SDK's `WebApiAdapter` extracts `saleorApiUrl` directly from the incoming request's `saleor-api-url` header
2. **Processing Order**: The SDK reads these headers in `createHandler()` **BEFORE** any of our code runs (APL, fetch wrapper, etc.)
3. **JWT Verification**: The JWT signature contains an `aud` (audience) claim with the HTTP URL from Saleor, but verification expects it to match the HTTPS URL we use
4. **Request Context**: The entire webhook processing context uses the `saleorApiUrl` extracted from headers

**The `withHttpsHeaders` wrapper fixes this at the source** by creating a new Request object with modified headers BEFORE the SDK's `createHandler()` reads them, ensuring all code paths see HTTPS URLs from the very beginning.

This is why the wrapper must be in the `compose()` chain - it needs to run before the SDK's handler processes the request.

## Summary

The HTTP/HTTPS URL mismatch issue required a **three-layered solution**:

1. **Request Header Transformation (`withHttpsHeaders`)** - The PRIMARY fix that modifies incoming request headers before the SDK reads them
2. **Global Fetch Wrapper (`https-fetch-wrapper.ts` + `instrumentation.ts`)** - Ensures all outgoing SDK requests use HTTPS
3. **APL Wrapper (`HttpsEnforcingAPL`)** - Normalizes stored authentication data to always use HTTPS

The key insight is that the SDK reads the `saleor-api-url` header very early in the request processing, before any of our middleware runs. The `withHttpsHeaders` wrapper solves this by intercepting the request at the route handler level, creating a new Request object with HTTPS headers before passing it to the SDK.

After this fix, the logs should show:
- `[withHttpsHeaders] Converted saleor-api-url header from HTTP to HTTPS`
- `[HttpsEnforcingAPL] APL authentication data found and normalized`
- `[verifyWebhookSignature] Webhook signature verification succeeded`
- `[ORDER_FULLY_PAID route] Successfully processed ORDER_FULLY_PAID webhook`