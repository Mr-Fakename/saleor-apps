import Stripe from "stripe";

import { createLogger } from "@/lib/logger";
import { PAYMENT_POLICY_METADATA_KEY } from "@/modules/payment-fee-gate/payment-method-policy";

import { PaypalCaptureLogger } from "./types";

/** A3d "soon" checks after an AUTHORIZATION_SUCCESS: +15, +45 and +120 s. */
export const SOON_CHECK_DELAYS_MS: ReadonlyArray<number> = [15_000, 45_000, 120_000];

/** Pending check series and follow-ups kept in memory at most; the sweep covers the rest. */
const DEFAULT_MAX_PENDING = 500;

/** One PaymentIntent to check, and where its Stripe key comes from. */
export type PaypalCaptureCheckTarget = {
  saleorApiUrl: string;
  appId: string;
  paymentIntentId: string;
  stripeConfig: { configId: string } | { channelId: string };
};

/**
 * Given to the Stripe webhook and process-session use cases with the PayPal-fee gate on (null
 * with it off): they call it after reporting AUTHORIZATION_SUCCESS.
 */
export interface IPaypalCaptureTrigger {
  onAuthorizationSuccess(args: {
    saleorApiUrl: string;
    appId: string;
    paymentIntent: Pick<Stripe.PaymentIntent, "id" | "metadata">;
    stripeConfig: { configId: string } | { channelId: string };
  }): void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * In-process timers for A3d checks: a series at SOON_CHECK_DELAYS_MS after an authorization of a
 * paypal-only PaymentIntent, and one follow-up after each capture / release request. Only a
 * speed-up: a check that is lost (restart, bound reached) is made by the 60 s sweep instead,
 * and every check runs under the PaymentIntent's DynamoDB claim.
 */
export class CaptureCheckScheduler implements IPaypalCaptureTrigger {
  private runCheck: (target: PaypalCaptureCheckTarget) => Promise<unknown>;
  private delaysMs: ReadonlyArray<number>;
  private maxPending: number;
  private logger: PaypalCaptureLogger;
  private pending = new Map<string, TimerHandle[]>();
  private followUpSequence = 0;

  constructor(deps: {
    runCheck: (target: PaypalCaptureCheckTarget) => Promise<unknown>;
    delaysMs?: ReadonlyArray<number>;
    maxPending?: number;
    logger?: PaypalCaptureLogger;
  }) {
    this.runCheck = deps.runCheck;
    this.delaysMs = deps.delaysMs ?? SOON_CHECK_DELAYS_MS;
    this.maxPending = deps.maxPending ?? DEFAULT_MAX_PENDING;
    this.logger = deps.logger ?? createLogger("PaypalCaptureCheckScheduler");
  }

  onAuthorizationSuccess(args: Parameters<IPaypalCaptureTrigger["onAuthorizationSuccess"]>[0]): void {
    // Only the app's paypal-only PaymentIntents: card and other authorizations are not ours.
    if (args.paymentIntent.metadata?.[PAYMENT_POLICY_METADATA_KEY] !== "paypal-only") {
      return;
    }

    const target: PaypalCaptureCheckTarget = {
      saleorApiUrl: args.saleorApiUrl,
      appId: args.appId,
      paymentIntentId: args.paymentIntent.id,
      stripeConfig: args.stripeConfig,
    };
    const key = `soon|${target.saleorApiUrl}|${target.appId}|${target.paymentIntentId}`;

    // The Stripe webhook and process-session both report the same authorization.
    if (this.pending.has(key)) {
      return;
    }

    this.schedule(key, target, this.delaysMs);
  }

  /** One check of `target` after `delayMs` (after a capture or release request). */
  scheduleFollowUp(target: PaypalCaptureCheckTarget, delayMs: number): void {
    this.followUpSequence += 1;
    this.schedule(`follow-up|${target.paymentIntentId}|${this.followUpSequence}`, target, [delayMs]);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  stop(): void {
    for (const handles of this.pending.values()) {
      handles.forEach((handle) => clearTimeout(handle));
    }

    this.pending.clear();
  }

  private schedule(key: string, target: PaypalCaptureCheckTarget, delaysMs: ReadonlyArray<number>) {
    if (this.pending.size >= this.maxPending) {
      this.logger.warn("Too many PayPal capture checks pending; the sweep will check this one", {
        paymentIntentId: target.paymentIntentId,
        pending: this.pending.size,
      });

      return;
    }

    let remaining = delaysMs.length;
    const handles = delaysMs.map((delayMs) => {
      const handle = setTimeout(() => {
        remaining -= 1;

        if (remaining === 0) {
          this.pending.delete(key);
        }

        void this.run(target);
      }, delayMs);

      // Never keeps a process alive on its own.
      (handle as { unref?: () => void }).unref?.();

      return handle;
    });

    this.pending.set(key, handles);
  }

  private async run(target: PaypalCaptureCheckTarget) {
    try {
      await this.runCheck(target);
    } catch (error) {
      this.logger.error("PayPal capture check failed", {
        paymentIntentId: target.paymentIntentId,
        error,
      });
    }
  }
}
