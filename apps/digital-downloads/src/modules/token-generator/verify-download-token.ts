import crypto from "crypto";
import { err, ok, Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { env } from "@/lib/env";
import { parseDownloadToken } from "@/modules/token-generator/generate-download-token";

export const TokenVerificationErrors = {
  InvalidFormatError: BaseError.subclass("InvalidFormatError", {
    props: {
      _brand: "TokenVerification.InvalidFormatError" as const,
    },
  }),
  InvalidSignatureError: BaseError.subclass("InvalidSignatureError", {
    props: {
      _brand: "TokenVerification.InvalidSignatureError" as const,
    },
  }),
};

export type TokenVerificationError =
  | InstanceType<typeof TokenVerificationErrors.InvalidFormatError>
  | InstanceType<typeof TokenVerificationErrors.InvalidSignatureError>;

/**
 * Verifies the signature of a download token
 *
 * @param token - The signed token string to verify
 * @returns Result with success or error
 */
export function verifyDownloadToken(token: string): Result<void, TokenVerificationError> {
  try {
    const parts = token.split(".");

    if (parts.length !== 2) {
      return err(
        new TokenVerificationErrors.InvalidFormatError("Token format is invalid", {
          cause: { token },
        }),
      );
    }

    const [encodedPayload, providedSignature] = parts;

    if (!encodedPayload || !providedSignature) {
      return err(
        new TokenVerificationErrors.InvalidFormatError("Token format is invalid", {
          cause: { token },
        }),
      );
    }

    // Parse to validate payload structure
    const payload = parseDownloadToken(token);

    if (!payload) {
      return err(
        new TokenVerificationErrors.InvalidFormatError("Token payload is invalid", {
          cause: { token },
        }),
      );
    }

    // Recreate the payload string for signature verification
    const payloadString = `${payload.orderId}:${payload.fileUrl}:${payload.expiresAt}`;
    const hmac = crypto.createHmac("sha256", env.SECRET_KEY);

    hmac.update(payloadString);

    const expectedSignature = hmac.digest("hex");

    // Use timing-safe comparison
    if (!crypto.timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedSignature))) {
      return err(
        new TokenVerificationErrors.InvalidSignatureError("Token signature is invalid", {
          cause: { token },
        }),
      );
    }

    return ok(undefined);
  } catch (error) {
    return err(
      new TokenVerificationErrors.InvalidFormatError("Token verification failed", {
        cause: error,
      }),
    );
  }
}
