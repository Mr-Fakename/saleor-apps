# Stripe Refund Webhook HTTP/HTTPS URL Inconsistency Fix

## Problem Summary

The Stripe refund webhook was failing with authentication errors despite having valid pspReference data. Through comprehensive debugging and log analysis, we discovered the root cause:

**Saleor is delivering different webhook types with inconsistent URL protocols:**
- Working webhooks (transaction-initialize-session, transaction-process-session) receive HTTPS URLs: `https://saleor-api.vps.daybreakdevelopment.eu/graphql/`
- Failing refund webhook receives HTTP URLs: `http://saleor-api.vps.daybreakdevelopment.eu/graphql/`

This inconsistency causes APL (App Permission Layer) authentication failures because:
1. Authentication data is stored with HTTPS URLs during app installation
2. The refund webhook tries to authenticate with HTTP URLs
3. APL lookup fails, causing the webhook framework to reject the request before reaching our handler

## Log Evidence

**Working webhook logs show:**
```json
{
  "authDataSaleorApiUrl": "https://saleor-api.vps.daybreakdevelopment.eu/graphql/",
  "=== RECIPIENT VERIFICATION DEBUG: Recipient verification passed ==="
}
```

**Failing refund webhook logs show:**
```json
{
  "authDataSaleorApiUrl": "http://saleor-api.vps.daybreakdevelopment.eu/graphql/",
  "rawSaleorApiUrl": "http://saleor-api.vps.daybreakdevelopment.eu/graphql/"
}
```

The refund webhook never reaches recipient verification, confirming framework-level authentication failure.

## Solution Implemented

### 1. Enhanced HttpsEnforcingAPL

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
- APL authentication lookups with different URL variants
- Webhook framework authentication steps
- Request body and header analysis
- Signature verification details

### 3. Debug Endpoints

Created test endpoints to verify the fix:
- `/api/debug-apl` - Shows all stored authentication data
- `/api/debug-auth` - Tests HTTP vs HTTPS URL lookups
- `/api/test-apl-fix` - Runs comprehensive APL consistency tests

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

## Testing

Use the test endpoints to verify the fix:

```bash
# Test APL authentication lookup
curl https://your-app-domain/api/debug-auth

# Run comprehensive APL consistency test
curl https://your-app-domain/api/test-apl-fix
```

## Next Steps

1. **Monitor Logs**: Watch for successful refund webhook processing
2. **Test Refunds**: Attempt actual refund operations to verify end-to-end functionality
3. **Saleor Investigation**: Consider reporting the URL inconsistency to Saleor as it may indicate a configuration or delivery system issue

## Files Modified

- `src/lib/https-enforcing-apl.ts` - Enhanced with comprehensive URL fallback logic
- `src/app/api/webhooks/saleor/transaction-refund-requested/route.ts` - Added comprehensive debug logging
- `src/app/api/webhooks/saleor/transaction-refund-requested/webhook-definition.ts` - Added signature verification debugging
- `src/app/api/debug-*` endpoints - Created for testing and verification
- Multiple use case and helper files - Enhanced with debug logging

The solution addresses the immediate authentication issue while maintaining compatibility with both HTTP and HTTPS webhook deliveries from Saleor.