// Use `process.env` here to avoid broken Next.js build
import type { Instrumentation } from "next";

export const register = async () => {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.OTEL_ENABLED === "true") {
    await import("./instrumentations/otel-node");
  }

  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PUBLIC_SENTRY_DSN) {
    await import("./instrumentations/sentry-node");
  }

  // Initialize DynamoDB tables on server startup
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.INIT_DYNAMODB_ON_STARTUP === "true") {
    await import("./instrumentations/dynamodb-init");
  }

  /*
   * A3d: the PayPal capture worker, only with the PayPal-fee gate on (dess). Spike S3: register()
   * runs once per server process under `next start` and the standalone server.js, never during
   * `next build`. A worker that cannot start must not stop the server (a register() error aborts
   * the Next.js start): it is logged, and the authorizations wait for staff.
   */
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.PAYMENT_FEE_GATE?.trim()) {
    try {
      const { startPaypalCaptureWorkerFromEnv } = await import(
        "./instrumentations/paypal-capture-worker"
      );

      startPaypalCaptureWorkerFromEnv({ nextRuntime: process.env.NEXT_RUNTIME });
    } catch (error) {
      // console, not the app logger: loading the logger may be what failed.
      console.error("[PayPal capture worker] failed to start", error);
    }
  }
};

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    const { captureRequestError } = await import("@sentry/nextjs");

    captureRequestError(...args);
  }
};
