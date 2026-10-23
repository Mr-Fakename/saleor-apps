import { createLogger } from "@/lib/logger";
import { PaymentFeeGateConfig } from "@/modules/payment-fee-gate/payment-fee-gate-config";

import { PaypalCaptureLogger } from "./types";

export const PAYPAL_CAPTURE_FIRST_SWEEP_DELAY_MS = 30_000;
export const PAYPAL_CAPTURE_SWEEP_INTERVAL_MS = 60_000;

const WORKER_REGISTRY_KEY = "__saleorStripePaypalCaptureWorker";

/**
 * A3d: the capture worker runs in the Node.js server runtime (src/instrumentation.ts), with the
 * PayPal-fee gate on, whatever PAYMENT_FEE_PAYPAL_CAPTURE says: with the kill switch
 * ("automatic") new PaymentIntents are captured by Stripe, and the worker still captures, holds
 * or releases the authorizations made before the switch.
 */
export const shouldStartPaypalCaptureWorker = (args: {
  nextRuntime: string | undefined;
  paymentFeeGate: PaymentFeeGateConfig | null;
}): boolean => args.nextRuntime === "nodejs" && args.paymentFeeGate !== null;

type TimerHandle = ReturnType<typeof setTimeout>;

const unref = (handle: TimerHandle) => {
  (handle as { unref?: () => void }).unref?.();

  return handle;
};

/**
 * Runs the sweep once PAYPAL_CAPTURE_FIRST_SWEEP_DELAY_MS after start, then every
 * PAYPAL_CAPTURE_SWEEP_INTERVAL_MS, never two at once in this process (a tick during a slow
 * sweep is skipped), and survives any sweep error.
 *
 * Spike S3 (2026-10-23, Next.js 15.5.28, local `next build` + run, no Docker): register() runs
 * once per server process, before "Ready", under both `next start` and the standalone
 * `node apps/stripe/server.js` the image runs; never during `next build`; a timer set there
 * keeps firing with or without requests. A restart is a new process: register() runs again,
 * the timers start again, and the DynamoDB lease (90 s) makes a new process wait for an old
 * one's lease to expire.
 */
export class PaypalCaptureWorker {
  private sweep: () => Promise<unknown>;
  private firstDelayMs: number;
  private intervalMs: number;
  private logger: PaypalCaptureLogger;
  private started = false;
  private sweeping = false;
  private firstTimer: TimerHandle | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: {
    sweep: () => Promise<unknown>;
    firstDelayMs?: number;
    intervalMs?: number;
    logger?: PaypalCaptureLogger;
  }) {
    this.sweep = deps.sweep;
    this.firstDelayMs = deps.firstDelayMs ?? PAYPAL_CAPTURE_FIRST_SWEEP_DELAY_MS;
    this.intervalMs = deps.intervalMs ?? PAYPAL_CAPTURE_SWEEP_INTERVAL_MS;
    this.logger = deps.logger ?? createLogger("PaypalCaptureWorker");
  }

  /** False when already started. */
  start(): boolean {
    if (this.started) {
      return false;
    }

    this.started = true;
    this.firstTimer = unref(
      setTimeout(() => {
        this.firstTimer = null;
        this.interval = unref(setInterval(() => void this.tick(), this.intervalMs));
        void this.tick();
      }, this.firstDelayMs),
    );

    this.logger.info("PayPal capture worker started", {
      firstSweepInMs: this.firstDelayMs,
      intervalMs: this.intervalMs,
    });

    return true;
  }

  stop(): void {
    if (this.firstTimer) {
      clearTimeout(this.firstTimer);
      this.firstTimer = null;
    }

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }

  private async tick() {
    if (this.sweeping) {
      this.logger.warn("PayPal capture sweep still running; skipping this tick");

      return;
    }

    this.sweeping = true;

    try {
      await this.sweep();
    } catch (error) {
      this.logger.error("PayPal capture sweep failed", { error });
    } finally {
      this.sweeping = false;
    }
  }
}

/** One worker per process, even if register() runs twice (it is a module-global guard). */
export const startPaypalCaptureWorkerOnce = (
  create: () => PaypalCaptureWorker,
  registry: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): boolean => {
  if (registry[WORKER_REGISTRY_KEY]) {
    return false;
  }

  const worker = create();

  registry[WORKER_REGISTRY_KEY] = worker;

  return worker.start();
};
