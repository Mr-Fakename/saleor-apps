/**
 * A3d capture worker entry, imported by src/instrumentation.ts in the Node.js runtime when
 * PAYMENT_FEE_GATE is set. Importing it validates the env (src/lib/env.ts).
 */
import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { paymentFeeGateFromEnv } from "@/modules/payment-fee-gate/payment-fee-gate-config";
import { paypalCaptureFromEnv } from "@/modules/payment-fee-gate/paypal-capture-config";
import { getPaypalCaptureRuntime } from "@/modules/paypal-capture/paypal-capture-runtime";
import {
  shouldStartPaypalCaptureWorker,
  startPaypalCaptureWorkerOnce,
} from "@/modules/paypal-capture/paypal-capture-worker";

const logger = createLogger("PaypalCaptureWorkerStartup");

export const startPaypalCaptureWorkerFromEnv = (args: { nextRuntime: string | undefined }): boolean => {
  const paymentFeeGate = paymentFeeGateFromEnv(env);

  if (!shouldStartPaypalCaptureWorker({ nextRuntime: args.nextRuntime, paymentFeeGate })) {
    return false;
  }

  const runtime = getPaypalCaptureRuntime();

  if (!runtime) {
    return false;
  }

  const started = startPaypalCaptureWorkerOnce(() => runtime.worker);

  logger.info("PayPal capture worker (A3d)", {
    started,
    paypalCapture: paypalCaptureFromEnv(env),
  });

  return started;
};
