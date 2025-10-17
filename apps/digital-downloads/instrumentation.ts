// Use `process.env` here to avoid broken Next.js build
import type { Instrumentation } from "next";

export const register = async () => {
  // CRITICAL: Install fetch wrapper FIRST before any other instrumentation
  // This ensures all SDK requests use HTTPS URLs
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./src/lib/https-fetch-wrapper");
  }

  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.OTEL_ENABLED === "true") {
    await import("./src/instrumentations/otel-node");
  }

  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PUBLIC_SENTRY_DSN) {
    await import("./src/instrumentations/sentry-node");
  }
};

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    const { captureRequestError } = await import("@sentry/nextjs");

    captureRequestError(...args);
  }
};
