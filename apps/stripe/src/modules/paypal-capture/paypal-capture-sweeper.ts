import { APL, AuthData } from "@saleor/app-sdk/APL";

import { createLogger } from "@/lib/logger";
import { AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { createStripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";
import { StripeRestrictedKey } from "@/modules/stripe/stripe-restricted-key";

import { PaypalCaptureCheckTarget } from "./capture-check-scheduler";
import { ICaptureCoordinationRepo } from "./capture-coordination-repo";
import { PaypalCaptureCoordinator } from "./paypal-capture-coordinator";
import { ISaleorCaptureGateway } from "./saleor-capture-gateway";
import { IPaypalCaptureStripeApi, PaypalCaptureLogger } from "./types";

/** Longer than the sweep interval (60 s): renewed by every sweep of the holder. */
export const PAYPAL_CAPTURE_SWEEP_LEASE_TTL_MS = 90_000;

export type PaypalCaptureSweepSummary = {
  lease: "acquired" | "held-elsewhere" | "error";
  installations: number;
  /** Stripe accounts searched. */
  searched: number;
  found: number;
  checked: number;
  failures: number;
};

/**
 * A3d sweep (docs/plans/2026-10-22-paypal-fee-gate-design.md §9), run by PaypalCaptureWorker:
 * under the DynamoDB lease (one sweeper at a time across processes), for every installation in
 * the APL and every Stripe account in its configuration, the Stripe search
 *   status:"requires_capture" AND metadata["saleor_payment_policy"]:"paypal-only"
 * then one coordinator check per PaymentIntent (live re-read, DynamoDB RecordedTransaction,
 * Saleor transaction(id), decideCapture). Every failure is logged and the sweep goes on.
 */
export class PaypalCaptureSweeper {
  private apl: Pick<APL, "getAll">;
  private appConfigRepo: Pick<AppConfigRepo, "getRootConfig">;
  private repo: Pick<ICaptureCoordinationRepo, "acquireSweepLease">;
  private coordinator: Pick<PaypalCaptureCoordinator, "checkPaymentIntent">;
  private createStripeApi: (key: StripeRestrictedKey) => IPaypalCaptureStripeApi;
  private createSaleorGateway: (authData: AuthData) => ISaleorCaptureGateway;
  private scheduleFollowUp?: (target: PaypalCaptureCheckTarget, delayMs: number) => void;
  private holderId: string;
  private now: () => number;
  private leaseTtlMs: number;
  private logger: PaypalCaptureLogger;

  constructor(deps: {
    apl: Pick<APL, "getAll">;
    appConfigRepo: Pick<AppConfigRepo, "getRootConfig">;
    repo: Pick<ICaptureCoordinationRepo, "acquireSweepLease">;
    coordinator: Pick<PaypalCaptureCoordinator, "checkPaymentIntent">;
    createStripeApi: (key: StripeRestrictedKey) => IPaypalCaptureStripeApi;
    createSaleorGateway: (authData: AuthData) => ISaleorCaptureGateway;
    scheduleFollowUp?: (target: PaypalCaptureCheckTarget, delayMs: number) => void;
    holderId: string;
    now?: () => number;
    leaseTtlMs?: number;
    logger?: PaypalCaptureLogger;
  }) {
    this.apl = deps.apl;
    this.appConfigRepo = deps.appConfigRepo;
    this.repo = deps.repo;
    this.coordinator = deps.coordinator;
    this.createStripeApi = deps.createStripeApi;
    this.createSaleorGateway = deps.createSaleorGateway;
    this.scheduleFollowUp = deps.scheduleFollowUp;
    this.holderId = deps.holderId;
    this.now = deps.now ?? Date.now;
    this.leaseTtlMs = deps.leaseTtlMs ?? PAYPAL_CAPTURE_SWEEP_LEASE_TTL_MS;
    this.logger = deps.logger ?? createLogger("PaypalCaptureSweeper");
  }

  async sweep(): Promise<PaypalCaptureSweepSummary> {
    const summary: PaypalCaptureSweepSummary = {
      lease: "acquired",
      installations: 0,
      searched: 0,
      found: 0,
      checked: 0,
      failures: 0,
    };

    const lease = await this.repo.acquireSweepLease({
      holderId: this.holderId,
      nowMs: this.now(),
      ttlMs: this.leaseTtlMs,
    });

    if (lease.isErr()) {
      this.logger.error("PayPal capture sweep skipped: the lease store is unavailable", {
        error: lease.error,
      });

      return { ...summary, lease: "error" };
    }

    if (!lease.value) {
      this.logger.debug("PayPal capture sweep skipped: another process holds the lease");

      return { ...summary, lease: "held-elsewhere" };
    }

    let installations: AuthData[];

    try {
      installations = await this.apl.getAll();
    } catch (error) {
      this.logger.error("PayPal capture sweep: failed to read the APL", { error });

      return { ...summary, failures: 1 };
    }

    for (const authData of installations) {
      summary.installations += 1;
      await this.sweepInstallation(authData, summary);
    }

    const log = summary.failures > 0 ? this.logger.warn : this.logger.debug;

    log.call(this.logger, "PayPal capture sweep done", summary);

    return summary;
  }

  private async sweepInstallation(authData: AuthData, summary: PaypalCaptureSweepSummary) {
    const saleorApiUrl = createSaleorApiUrl(authData.saleorApiUrl);

    if (saleorApiUrl.isErr()) {
      summary.failures += 1;
      this.logger.error("PayPal capture sweep: invalid Saleor API URL in the APL", {
        error: saleorApiUrl.error,
      });

      return;
    }

    const access = { saleorApiUrl: saleorApiUrl.value, appId: authData.appId };
    const rootConfig = await this.appConfigRepo.getRootConfig(access);

    if (rootConfig.isErr()) {
      summary.failures += 1;
      this.logger.error("PayPal capture sweep: failed to read the app configuration", {
        saleorApiUrl: access.saleorApiUrl,
        error: rootConfig.error,
      });

      return;
    }

    const saleor = this.createSaleorGateway(authData);
    const searchedKeys = new Set<string>();

    for (const config of rootConfig.value.getAllConfigsAsList()) {
      // Several configs can share a Stripe account: search it once.
      if (searchedKeys.has(config.restrictedKey)) {
        continue;
      }

      searchedKeys.add(config.restrictedKey);

      const stripe = this.createStripeApi(config.restrictedKey);
      const search = await stripe.searchPaymentIntentsAwaitingAppCapture();

      summary.searched += 1;

      if (search.isErr()) {
        summary.failures += 1;
        this.logger.error("PayPal capture sweep: the Stripe search failed", {
          configId: config.id,
          error: search.error,
        });

        continue;
      }

      summary.found += search.value.length;

      for (const paymentIntent of search.value) {
        const target: PaypalCaptureCheckTarget = {
          saleorApiUrl: access.saleorApiUrl,
          appId: access.appId,
          paymentIntentId: paymentIntent.id,
          stripeConfig: { configId: config.id },
        };

        try {
          const outcome = await this.coordinator.checkPaymentIntent({
            access,
            stripe,
            saleor,
            paymentIntentId: createStripePaymentIntentId(paymentIntent.id),
            trigger: "sweep",
            scheduleFollowUp: (delayMs) => this.scheduleFollowUp?.(target, delayMs),
          });

          summary.checked += 1;

          if (outcome.action === "error") {
            summary.failures += 1;
          }
        } catch (error) {
          summary.failures += 1;
          this.logger.error("PayPal capture sweep: a check failed", {
            paymentIntentId: paymentIntent.id,
            error,
          });
        }
      }
    }
  }
}
