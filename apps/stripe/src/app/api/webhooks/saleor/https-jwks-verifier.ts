import { verifySignatureWithJwks, getJwksUrlFromSaleorApiUrl } from "@saleor/app-sdk/auth";
import { createLogger } from "@/lib/logger";

const logger = createLogger("https-jwks-verifier");

/**
 * Custom webhook signature verifier that forces HTTPS URLs for JWKS fetching
 * This fixes the issue where refund webhooks receive HTTP URLs but JWKS should be fetched over HTTPS
 */
export async function httpsJwksVerifier(saleorApiUrl: string, signature: string, rawBody: string) {
  logger.debug("=== HTTPS JWKS VERIFIER: Starting verification ===", {
    originalSaleorApiUrl: saleorApiUrl,
    signatureLength: signature?.length,
    rawBodyLength: rawBody?.length,
  });

  // Force HTTPS URL for JWKS fetching
  const httpsSaleorApiUrl = saleorApiUrl.replace(/^http:\/\//, "https://");

  logger.debug("=== HTTPS JWKS VERIFIER: URL conversion ===", {
    originalUrl: saleorApiUrl,
    httpsUrl: httpsSaleorApiUrl,
    isConverted: saleorApiUrl !== httpsSaleorApiUrl,
  });

  // Construct JWKS URL
  const jwksUrl = getJwksUrlFromSaleorApiUrl(httpsSaleorApiUrl);

  logger.debug("=== HTTPS JWKS VERIFIER: JWKS URL ===", {
    jwksUrl,
  });

  try {
    // Fetch JWKS from the HTTPS endpoint
    const jwksResponse = await fetch(jwksUrl);

    if (!jwksResponse.ok) {
      logger.error("=== HTTPS JWKS VERIFIER: JWKS fetch failed ===", {
        status: jwksResponse.status,
        statusText: jwksResponse.statusText,
        jwksUrl,
      });
      throw new Error(`Failed to fetch JWKS: ${jwksResponse.status} ${jwksResponse.statusText}`);
    }

    const jwksData = await jwksResponse.text();

    logger.debug("=== HTTPS JWKS VERIFIER: JWKS fetched ===", {
      jwksLength: jwksData.length,
      jwksPreview: jwksData.substring(0, 200),
    });

    // Verify signature using the fetched JWKS
    const result = await verifySignatureWithJwks(jwksData, signature, rawBody);

    logger.debug("=== HTTPS JWKS VERIFIER: Verification successful ===");

    return result;
  } catch (error) {
    logger.error("=== HTTPS JWKS VERIFIER: Verification failed ===", {
      error: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      jwksUrl,
      originalSaleorApiUrl: saleorApiUrl,
      httpsSaleorApiUrl,
    });

    throw error;
  }
}
