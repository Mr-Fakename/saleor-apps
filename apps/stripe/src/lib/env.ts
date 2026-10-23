import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { fromError } from "zod-validation-error";

import { BaseError } from "@/lib/errors";
import { parsePaymentFeeGateEnv } from "@/modules/payment-fee-gate/payment-fee-gate-config";
import { parsePaypalCaptureEnv } from "@/modules/payment-fee-gate/paypal-capture-config";

// https://env.t3.gg/docs/recipes#booleans
const booleanSchema = z
  .string()
  .refine((s) => s === "true" || s === "false")
  .transform((s) => s === "true");

export const env = createEnv({
  client: {
    NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  },
  server: {
    ALLOWED_DOMAIN_PATTERN: z.string().optional(),
    APL: z.enum(["saleor-cloud", "file", "dynamodb"]).optional().default("file"),
    APP_API_BASE_URL: z.string().optional(),
    APP_IFRAME_BASE_URL: z.string().optional(),
    APP_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    MANIFEST_APP_ID: z.string().optional().default("saleor.app.payment.stripe"),
    OTEL_ACCESS_TOKEN: z.string().optional(),
    OTEL_ENABLED: booleanSchema.optional().default("false"),
    OTEL_SERVICE_NAME: z.string().optional().default("saleor-app-payment-stripe"),
    PORT: z.coerce.number().optional().default(3000),
    REPOSITORY_URL: z.string().optional(),
    SECRET_KEY: z.string(),
    VERCEL_ENV: z.string().optional(),
    VERCEL_GIT_COMMIT_SHA: z.string().optional(),
    STRIPE_PARTNER_ID: z.string().optional(),
    DYNAMODB_MAIN_TABLE_NAME: z.string(),
    AWS_REGION: z.string(),
    AWS_ACCESS_KEY_ID: z.string(),
    AWS_SECRET_ACCESS_KEY: z.string(),
    APPSTORE_URL: z.string().optional(),
    APP_NAME: z.string().optional().default("Stripe"),
    /**
     * Comma-separated browser origins allowed to call /api/update-payment-intent directly.
     * Unset = none: the storefronts call it server-to-server through their own proxy.
     */
    UPDATE_PAYMENT_INTENT_ALLOWED_ORIGINS: z.string().optional(),
    /**
     * PayPal-fee hard gate (A3c): "paypal" turns it on; unset or empty = off. The four
     * variables are checked together below. See src/modules/payment-fee-gate/.
     */
    PAYMENT_FEE_GATE: z.string().optional(),
    PAYMENT_FEE_RATE_PERCENT: z.string().optional(),
    PAYMENT_FEE_VARIANT_ID: z.string().optional(),
    PAYMENT_FEE_METADATA_KEY: z.string().optional(),
    /**
     * A3d (authorize, then capture): "manual" (default with the gate on) or "automatic" (kill
     * switch). No effect with the gate off. See src/modules/payment-fee-gate/paypal-capture-config.ts.
     */
    PAYMENT_FEE_PAYPAL_CAPTURE: z.string().optional(),
  },
  shared: {
    NODE_ENV: z.enum(["development", "production", "test"]).optional().default("development"),
    ENV: z.enum(["local", "development", "staging", "production"]).optional().default("local"),
  },
  // we use the manual destruction here to validate if env variable is set inside turbo.json
  runtimeEnv: {
    ALLOWED_DOMAIN_PATTERN: process.env.ALLOWED_DOMAIN_PATTERN,
    APL: process.env.APL,
    APP_API_BASE_URL: process.env.APP_API_BASE_URL,
    APP_IFRAME_BASE_URL: process.env.APP_IFRAME_BASE_URL,
    APP_LOG_LEVEL: process.env.APP_LOG_LEVEL,
    ENV: process.env.ENV,
    MANIFEST_APP_ID: process.env.MANIFEST_APP_ID,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NODE_ENV: process.env.NODE_ENV,
    OTEL_ACCESS_TOKEN: process.env.OTEL_ACCESS_TOKEN,
    OTEL_ENABLED: process.env.OTEL_ENABLED,
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME,
    PORT: process.env.PORT,
    REPOSITORY_URL: process.env.REPOSITORY_URL,
    SECRET_KEY: process.env.SECRET_KEY,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
    STRIPE_PARTNER_ID: process.env.STRIPE_PARTNER_ID,
    DYNAMODB_MAIN_TABLE_NAME: process.env.DYNAMODB_MAIN_TABLE_NAME,
    AWS_REGION: process.env.AWS_REGION,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    APPSTORE_URL: process.env.APPSTORE_URL,
    APP_NAME: process.env.APP_NAME,
    UPDATE_PAYMENT_INTENT_ALLOWED_ORIGINS: process.env.UPDATE_PAYMENT_INTENT_ALLOWED_ORIGINS,
    PAYMENT_FEE_GATE: process.env.PAYMENT_FEE_GATE,
    PAYMENT_FEE_RATE_PERCENT: process.env.PAYMENT_FEE_RATE_PERCENT,
    PAYMENT_FEE_VARIANT_ID: process.env.PAYMENT_FEE_VARIANT_ID,
    PAYMENT_FEE_METADATA_KEY: process.env.PAYMENT_FEE_METADATA_KEY,
    PAYMENT_FEE_PAYPAL_CAPTURE: process.env.PAYMENT_FEE_PAYPAL_CAPTURE,
  },
  isServer: typeof window === "undefined" || process.env.NODE_ENV === "test",
  onValidationError(issues) {
    const validationError = fromError(issues);

    const EnvValidationError = BaseError.subclass("EnvValidationError");

    throw new EnvValidationError(validationError.toString(), {
      cause: issues,
    });
  },
});

/*
 * PayPal-fee hard gate (A3c §4): with PAYMENT_FEE_GATE=paypal, an invalid or missing rate or
 * variant stops the app here, when this module loads (every route imports it, including the
 * /api/manifest healthcheck), instead of serving PayPal with a fee it cannot verify. Server
 * only: in the browser (sentry.client.config.ts) the server variables are not readable.
 */
if (typeof window === "undefined" || process.env.NODE_ENV === "test") {
  const paymentFeeGate = parsePaymentFeeGateEnv({
    PAYMENT_FEE_GATE: env.PAYMENT_FEE_GATE,
    PAYMENT_FEE_RATE_PERCENT: env.PAYMENT_FEE_RATE_PERCENT,
    PAYMENT_FEE_VARIANT_ID: env.PAYMENT_FEE_VARIANT_ID,
    PAYMENT_FEE_METADATA_KEY: env.PAYMENT_FEE_METADATA_KEY,
  });

  if (paymentFeeGate.isErr()) {
    throw paymentFeeGate.error;
  }

  // A3d: an unknown PAYMENT_FEE_PAYPAL_CAPTURE stops the app too, gate on or off.
  const paypalCapture = parsePaypalCaptureEnv({
    PAYMENT_FEE_GATE: env.PAYMENT_FEE_GATE,
    PAYMENT_FEE_PAYPAL_CAPTURE: env.PAYMENT_FEE_PAYPAL_CAPTURE,
  });

  if (paypalCapture.isErr()) {
    throw paypalCapture.error;
  }
}
