import { verifySignatureWithJwks } from "@saleor/app-sdk/auth";
import { createLogger } from "@/lib/logger";

const logger = createLogger("verifyWebhookSignature");

/**
 * Wrapper around verifySignatureWithJwks that adds debug logging
 * The actual HTTPS enforcement happens in the HttpsEnforcingAPL and httpsJwksVerifier
 */
export const verifyWebhookSignature = async (jwks: string, signature: string, rawBody: string) => {
  logger.debug("Verifying webhook signature", {
    jwksLength: jwks?.length,
    signatureLength: signature?.length,
    rawBodyLength: rawBody?.length,
  });

  // Decode the JWT signature to see what's inside (for debugging)
  try {
    const [header, payload] = signature.split(".");
    const decodedPayload = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      aud?: string;
      iss?: string;
      iat?: number;
      exp?: number;
    };
    logger.debug("JWT payload decoded", {
      aud: decodedPayload.aud,
      iss: decodedPayload.iss,
      iat: decodedPayload.iat,
      exp: decodedPayload.exp,
    });
  } catch (e) {
    logger.warn("Failed to decode JWT for debugging", { error: String(e) });
  }

  try {
    const result = await verifySignatureWithJwks(jwks, signature, rawBody);
    logger.debug("Webhook signature verification succeeded");
    return result;
  } catch (error) {
    logger.error("Webhook signature verification failed", {
      error: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
};
