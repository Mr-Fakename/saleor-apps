import { randomUUID } from "crypto";
import Stripe from "stripe";

import { createLogger } from "@/lib/logger";
import { PaymentFeeGateConfig } from "@/modules/payment-fee-gate/payment-fee-gate-config";
import { StripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";
import {
  TransactionRecorderError,
  TransactionRecorderRepo,
  TransactionRecorderRepoAccess,
} from "@/modules/transactions-recording/repositories/transaction-recorder-repo";

import { CaptureClaim, ICaptureCoordinationRepo } from "./capture-coordination-repo";
import {
  CAPTURE_HOLD_REASON_METADATA_KEY,
  CAPTURE_STATE_HELD,
  CAPTURE_STATE_METADATA_KEY,
} from "./capture-state-tags";
import {
  CaptureHoldReason,
  CaptureRecord,
  CaptureRule,
  CaptureSkipReason,
  CaptureTransaction,
  CaptureWaitReason,
  decideCapture,
} from "./decide-capture";
import { ISaleorCaptureGateway, SaleorCaptureGatewayTimeoutError } from "./saleor-capture-gateway";
import { IPaypalCaptureStripeApi, PaypalCaptureLogger } from "./types";

/**
 * How long a capture or release request is left to Saleor and the app's handler before the
 * PaymentIntent is read again. Saleor 3.22.74 sends the request from a Celery task, waits up to
 * 18 s for the answer (WEBHOOK_SYNC_TIMEOUT), and re-sends a 5xx answer 10 s later with an
 * EMPTY body, which cannot move money. 90 s covers that with a margin for the queue.
 */
export const CAPTURE_REQUEST_SETTLE_MS = 90_000;

/** Requests per PaymentIntent before the authorization is held (capture-stuck / release-stuck). */
export const MAX_CAPTURE_REQUEST_ATTEMPTS = 3;

/** The claim lock: longer than one check (a Stripe read, a DynamoDB read, a Saleor query and mutation). */
export const CAPTURE_CLAIM_LOCK_MS = 60_000;

/** A follow-up check runs this long after the settle window. */
const FOLLOW_UP_MARGIN_MS = 5_000;

export type CaptureCheckTrigger = "sweep" | "soon" | "follow-up";

type RequestDelivery = boolean | "unknown";

export type CaptureCheckOutcome =
  | { action: "busy" }
  | { action: "captured" }
  | { action: "released"; byApp: boolean }
  /**
   * delivered: true = Saleor accepted the request; false = Saleor refused it (no effect);
   * "unknown" = the call timed out, Saleor may have recorded it. Every case is counted and only
   * the re-read after the settle window decides what comes next.
   */
  | { action: "charge-requested"; attempt: number; delivered: RequestDelivery }
  | { action: "cancel-requested"; attempt: number; delivered: RequestDelivery }
  | { action: "held"; reason: CaptureHoldReason }
  | { action: "waiting"; reason: CaptureWaitReason | "request-settling" | "processing" }
  | { action: "skipped"; reason: CaptureSkipReason | "not-authorized" }
  | { action: "error"; during: "claim" | "stripe" | "record" | "saleor" };

type CheckArgs = {
  /** The app installation (the RecordedTransaction and the claim are scoped to it). */
  access: TransactionRecorderRepoAccess;
  stripe: Pick<IPaypalCaptureStripeApi, "getPaymentIntent">;
  saleor: ISaleorCaptureGateway;
  paymentIntentId: StripePaymentIntentId;
  trigger: CaptureCheckTrigger;
  /** Called after a request, with the delay of the check that should see its effect. */
  scheduleFollowUp?: (delayMs: number) => void;
};

/** `lockToken`: this check's claim lock (see checkPaymentIntent). */
type LockedCheckArgs = CheckArgs & { claim: CaptureClaim; nowMs: number; lockToken: string };

const isHeldWith = (transaction: CaptureTransaction, reason: CaptureHoldReason) =>
  transaction.metadata.some((item) => item.key === CAPTURE_STATE_METADATA_KEY && item.value === CAPTURE_STATE_HELD) &&
  transaction.metadata.some((item) => item.key === CAPTURE_HOLD_REASON_METADATA_KEY && item.value === reason);

/**
 * A3d (docs/plans/2026-10-22-paypal-fee-gate-design.md §9): one check of one paypal-only
 * PaymentIntent, under its claim lock:
 *
 *   live PaymentIntent -> DynamoDB RecordedTransaction -> Saleor transaction(id) -> decideCapture
 *
 * - capture: transactionRequestAction(CHARGE, order total). Saleor calls the app's
 *   TRANSACTION_CHARGE_REQUESTED handler (live status first, idempotency key
 *   capture:v1:<pi>:<amount>), and the Stripe payment_intent.succeeded webhook records
 *   CHARGE_SUCCESS as well.
 * - release (OD1, order CANCELED): transactionRequestAction(CANCEL).
 * - hold: tag the Saleor transaction (stripe_capture_state=held + reason + time), log an error,
 *   no Stripe write. Staff capture or cancel in the Dashboard (OD3 default for
 *   overcharge-by-fee: capture the order total).
 * - wait / skip: nothing written.
 *
 * Never relies on Saleor re-sending a request: Saleor 3.22.74 re-sends a transaction-request
 * webhook with an EMPTY body (saleor/core/models.py:199-203 EventPayload.save_as_file,
 * webhook/transport/utils.py:651-658), so a 503 answer ends as a failure with no Stripe effect.
 * After CAPTURE_REQUEST_SETTLE_MS the PaymentIntent is read again: succeeded = captured;
 * still requires_capture = the request had no effect, so the rule is checked again and the
 * request repeated, up to MAX_CAPTURE_REQUEST_ATTEMPTS, then held capture-stuck / release-stuck.
 * Every request is counted in DynamoDB before it is sent.
 *
 * The app's Stripe access here is read-only: it never captures or cancels a PaymentIntent
 * itself (no manifest change, no new endpoint).
 */
export class PaypalCaptureCoordinator {
  private repo: ICaptureCoordinationRepo;
  private transactionRecorder: Pick<TransactionRecorderRepo, "getTransactionByStripePaymentIntentId">;
  private gate: Pick<PaymentFeeGateConfig, "ratePercent" | "variantId" | "metadataKey">;
  private holderId: string;
  private now: () => number;
  private settleMs: number;
  private maxAttempts: number;
  private lockMs: number;
  private logger: PaypalCaptureLogger;
  /** PaymentIntents being checked by this coordinator (this process). */
  private inFlight = new Set<string>();

  constructor(deps: {
    repo: ICaptureCoordinationRepo;
    transactionRecorder: Pick<TransactionRecorderRepo, "getTransactionByStripePaymentIntentId">;
    gate: Pick<PaymentFeeGateConfig, "ratePercent" | "variantId" | "metadataKey">;
    /** This process: each check locks its claim with `<holderId>#<random>`. */
    holderId: string;
    now?: () => number;
    settleMs?: number;
    maxAttempts?: number;
    lockMs?: number;
    logger?: PaypalCaptureLogger;
  }) {
    this.repo = deps.repo;
    this.transactionRecorder = deps.transactionRecorder;
    this.gate = deps.gate;
    this.holderId = deps.holderId;
    this.now = deps.now ?? Date.now;
    this.settleMs = deps.settleMs ?? CAPTURE_REQUEST_SETTLE_MS;
    this.maxAttempts = deps.maxAttempts ?? MAX_CAPTURE_REQUEST_ATTEMPTS;
    this.lockMs = deps.lockMs ?? CAPTURE_CLAIM_LOCK_MS;
    this.logger = deps.logger ?? createLogger("PaypalCaptureCoordinator");
  }

  /**
   * One check at a time per PaymentIntent (review of d462375c, P2):
   * - in this process, a check of a PaymentIntent already being checked answers busy at once
   *   (the sweep and a soon check share this coordinator);
   * - across processes, the DynamoDB claim lock is taken with a token of THIS check
   *   (`<holderId>#<random>`), and a valid lock refuses every other check, the same process
   *   included. Before, the lock let the same holder back in, and one process sent two CHARGE
   *   requests and counted two attempts.
   */
  async checkPaymentIntent(args: CheckArgs): Promise<CaptureCheckOutcome> {
    const inFlightKey = `${args.access.saleorApiUrl}#${args.access.appId}#${args.paymentIntentId}`;

    if (this.inFlight.has(inFlightKey)) {
      this.logger.debug("PayPal capture check: this PaymentIntent is being checked already", {
        paymentIntentId: args.paymentIntentId,
        trigger: args.trigger,
      });

      return { action: "busy" };
    }

    this.inFlight.add(inFlightKey);

    try {
      return await this.checkUnderClaimLock(args, `${this.holderId}#${randomUUID()}`);
    } finally {
      this.inFlight.delete(inFlightKey);
    }
  }

  private async checkUnderClaimLock(args: CheckArgs, lockToken: string): Promise<CaptureCheckOutcome> {
    const nowMs = this.now();
    const lock = await this.repo.lockClaim({
      access: args.access,
      paymentIntentId: args.paymentIntentId,
      holderId: lockToken,
      nowMs,
      lockMs: this.lockMs,
    });

    if (lock.isErr()) {
      this.logger.error("PayPal capture check: the claim store is unavailable", {
        paymentIntentId: args.paymentIntentId,
        error: lock.error,
      });

      return { action: "error", during: "claim" };
    }

    if (!lock.value) {
      this.logger.debug("PayPal capture check: another check holds this PaymentIntent", {
        paymentIntentId: args.paymentIntentId,
        trigger: args.trigger,
      });

      return { action: "busy" };
    }

    try {
      return await this.checkLocked({ ...args, claim: lock.value, nowMs, lockToken });
    } finally {
      const unlock = await this.repo.unlockClaim({
        access: args.access,
        paymentIntentId: args.paymentIntentId,
        holderId: lockToken,
      });

      if (unlock.isErr()) {
        // The lock expires by itself after CAPTURE_CLAIM_LOCK_MS.
        this.logger.warn("PayPal capture check: failed to unlock the claim", {
          paymentIntentId: args.paymentIntentId,
          error: unlock.error,
        });
      }
    }
  }

  private async checkLocked(args: LockedCheckArgs): Promise<CaptureCheckOutcome> {
    const { claim, nowMs, paymentIntentId } = args;
    const live = await args.stripe.getPaymentIntent({ id: paymentIntentId });

    if (live.isErr()) {
      this.logger.warn("PayPal capture check: could not read the PaymentIntent", {
        paymentIntentId,
        error: live.error,
      });

      return { action: "error", during: "stripe" };
    }

    const paymentIntent = live.value;

    switch (paymentIntent.status) {
      case "succeeded":
        return this.observedCaptured(args, paymentIntent);
      case "canceled":
        return this.observedReleased(args, paymentIntent);
      case "processing":
        return { action: "waiting", reason: "processing" };
      case "requires_capture":
        break;
      default:
        return { action: "skipped", reason: "not-authorized" };
    }

    const requested = claim.state === "charge-requested" || claim.state === "cancel-requested";

    if (requested && claim.lastRequestAtMs !== null && nowMs - claim.lastRequestAtMs < this.settleMs) {
      return { action: "waiting", reason: "request-settling" };
    }

    if (requested) {
      // The settle window passed and Stripe still holds the authorization: no Stripe effect.
      this.logger.warn("PayPal capture check: the last request had no Stripe effect; checking again", {
        paymentIntentId,
        claimState: claim.state,
        chargeAttempts: claim.chargeAttempts,
        cancelAttempts: claim.cancelAttempts,
      });
    }

    const recordResult = await this.transactionRecorder.getTransactionByStripePaymentIntentId(
      args.access,
      paymentIntentId,
    );

    let record: CaptureRecord | null = null;

    if (recordResult.isOk()) {
      record = recordResult.value;
    } else if (!(recordResult.error instanceof TransactionRecorderError.TransactionMissingError)) {
      this.logger.warn("PayPal capture check: could not read the recorded transaction", {
        paymentIntentId,
        error: recordResult.error,
      });

      return { action: "error", during: "record" };
    }

    let transaction: CaptureTransaction | null = null;

    if (record) {
      const fetched = await args.saleor.fetchTransaction({ transactionId: record.saleorTransactionId });

      if (fetched.isErr()) {
        this.logger.warn("PayPal capture check: could not read the Saleor transaction", {
          paymentIntentId,
          transactionId: record.saleorTransactionId,
          error: fetched.error,
        });

        return { action: "error", during: "saleor" };
      }

      transaction = fetched.value;
    }

    const decision = decideCapture({
      paymentIntent,
      record,
      transaction,
      gate: this.gate,
      // R9: an authorization Saleor never recorded is held 30 min after the first check.
      authorizationWait: { firstCheckedAtMs: claim.firstCheckedAtMs ?? nowMs, nowMs },
    });
    const logAttributes = {
      paymentIntentId,
      transactionId: transaction?.id ?? record?.saleorTransactionId ?? null,
      orderId: transaction?.order?.id ?? null,
      orderNumber: transaction?.order?.number ?? null,
      trigger: args.trigger,
    };

    switch (decision.outcome) {
      case "skip": {
        const log =
          decision.reason === "not-recorded" || decision.reason === "transaction-not-found"
            ? this.logger.warn
            : this.logger.debug;

        log.call(this.logger, "PayPal capture check: not the app's to capture", {
          ...logAttributes,
          rule: decision.rule,
          reason: decision.reason,
        });

        return { action: "skipped", reason: decision.reason };
      }

      case "wait":
        this.logger.debug("PayPal capture check: not yet", {
          ...logAttributes,
          rule: decision.rule,
          reason: decision.reason,
        });

        return { action: "waiting", reason: decision.reason };

      case "hold":
        return this.hold(args, {
          transaction,
          reason: decision.reason,
          rule: decision.rule,
          detail: decision.detail,
          logAttributes,
        });

      case "capture":
        if (claim.chargeAttempts >= this.maxAttempts) {
          return this.hold(args, {
            transaction,
            reason: "capture-stuck",
            rule: decision.rule,
            detail: { chargeAttempts: claim.chargeAttempts },
            logAttributes,
          });
        }

        return this.request(args, {
          action: "charge",
          transactionId: transaction?.id ?? "",
          amount: decision.amount,
          logAttributes,
        });

      case "release":
        if (claim.cancelAttempts >= this.maxAttempts) {
          return this.hold(args, {
            transaction,
            reason: "release-stuck",
            rule: decision.rule,
            detail: { cancelAttempts: claim.cancelAttempts },
            logAttributes,
          });
        }

        return this.request(args, {
          action: "cancel",
          transactionId: transaction?.id ?? "",
          logAttributes,
        });
    }
  }

  /** Stripe shows the capture. The Stripe webhook (and the charge answer) record CHARGE_SUCCESS. */
  private async observedCaptured(args: LockedCheckArgs, paymentIntent: Stripe.PaymentIntent) {
    if (args.claim.state !== "captured") {
      this.logger.info("PayPal authorization captured", {
        paymentIntentId: paymentIntent.id,
        amountReceived: paymentIntent.amount_received,
        byApp: args.claim.state === "charge-requested",
      });
      await this.setState(args, "captured");
    }

    return { action: "captured" } as const;
  }

  /**
   * Stripe shows the authorization released. Spike S1: cancellation_reason is null for a cancel
   * by the app, by staff or by expiry alike, so the claim tells which: only a release the app
   * requested is expected.
   */
  private async observedReleased(args: LockedCheckArgs, paymentIntent: Stripe.PaymentIntent) {
    const byApp = args.claim.state === "cancel-requested";

    if (args.claim.state !== "released") {
      const log = byApp ? this.logger.info : this.logger.warn;

      log.call(
        this.logger,
        byApp
          ? "PayPal authorization released (order canceled)"
          : "PayPal authorization ended without an app request (expired, or canceled by staff)",
        {
          paymentIntentId: paymentIntent.id,
          canceledAt: paymentIntent.canceled_at,
          cancellationReason: paymentIntent.cancellation_reason,
        },
      );
      await this.setState(args, "released");
    }

    return { action: "released", byApp } as const;
  }

  private async hold(
    args: LockedCheckArgs,
    hold: {
      transaction: CaptureTransaction | null;
      reason: CaptureHoldReason;
      rule: CaptureRule;
      detail?: Readonly<Record<string, unknown>>;
      logAttributes: Record<string, unknown>;
    },
  ): Promise<CaptureCheckOutcome> {
    if (hold.transaction && isHeldWith(hold.transaction, hold.reason)) {
      return { action: "skipped", reason: "already-held" };
    }

    this.logger.error(
      "PayPal authorization HELD, not captured: staff must capture or cancel it in the Dashboard",
      {
        ...hold.logAttributes,
        reason: hold.reason,
        rule: hold.rule,
        detail: hold.detail,
      },
    );

    if (hold.transaction) {
      const tagged = await args.saleor.tagHold({
        transactionId: hold.transaction.id,
        reason: hold.reason,
        checkedAt: new Date(args.nowMs),
      });

      if (tagged.isErr()) {
        this.logger.error("Failed to tag the held PayPal authorization; the next check tags it again", {
          ...hold.logAttributes,
          reason: hold.reason,
          error: tagged.error,
        });
      }
    } else {
      this.logger.error("The held PayPal authorization has no Saleor transaction to tag", hold.logAttributes);
    }

    await this.setState(args, "held", hold.reason);

    return { action: "held", reason: hold.reason };
  }

  private async request(
    args: LockedCheckArgs,
    request:
      | { action: "charge"; transactionId: string; amount: number; logAttributes: Record<string, unknown> }
      | { action: "cancel"; transactionId: string; logAttributes: Record<string, unknown> },
  ): Promise<CaptureCheckOutcome> {
    // Counted before it is sent: a crash in between can never leave an uncounted request.
    const recorded = await this.repo.recordRequest({
      access: args.access,
      paymentIntentId: args.paymentIntentId,
      holderId: args.lockToken,
      action: request.action,
      nowMs: args.nowMs,
    });

    if (recorded.isErr()) {
      this.logger.error("PayPal capture check: could not count the request; not sending it", {
        ...request.logAttributes,
        action: request.action,
        error: recorded.error,
      });

      return { action: "error", during: "claim" };
    }

    const attempt =
      request.action === "charge" ? recorded.value.chargeAttempts : recorded.value.cancelAttempts;

    const sent =
      request.action === "charge"
        ? await args.saleor.requestCharge({ transactionId: request.transactionId, amount: request.amount })
        : await args.saleor.requestCancel({ transactionId: request.transactionId });

    const delivered: RequestDelivery = sent.isOk()
      ? true
      : sent.error instanceof SaleorCaptureGatewayTimeoutError
        ? "unknown"
        : false;

    if (delivered === "unknown") {
      /*
       * Saleor may have recorded the request and sent the webhook: never repeated blindly. After
       * the settle window the PaymentIntent is read again (succeeded = captured or released).
       */
      this.logger.warn("Saleor did not answer the PayPal capture request in time: outcome unknown", {
        ...request.logAttributes,
        action: request.action,
        attempt,
        error: sent.isErr() ? sent.error : null,
      });
    } else if (sent.isErr()) {
      this.logger.error("Saleor refused the PayPal capture request; it is checked again later", {
        ...request.logAttributes,
        action: request.action,
        attempt,
        error: sent.error,
      });
    } else {
      this.logger.info(
        request.action === "charge"
          ? "Requested the capture of a checked PayPal authorization"
          : "Requested the release of a canceled order's PayPal authorization",
        {
          ...request.logAttributes,
          attempt,
          ...(request.action === "charge" ? { amount: request.amount } : {}),
        },
      );
    }

    args.scheduleFollowUp?.(this.settleMs + FOLLOW_UP_MARGIN_MS);

    return request.action === "charge"
      ? { action: "charge-requested", attempt, delivered }
      : { action: "cancel-requested", attempt, delivered };
  }

  private async setState(
    args: LockedCheckArgs,
    state: "captured" | "released" | "held",
    holdReason?: string,
  ) {
    const result = await this.repo.setClaimState({
      access: args.access,
      paymentIntentId: args.paymentIntentId,
      holderId: args.lockToken,
      state,
      ...(holdReason === undefined ? {} : { holdReason }),
      nowMs: args.nowMs,
    });

    if (result.isErr()) {
      // Bookkeeping only: Stripe and Saleor stay the truth for the next check.
      this.logger.warn("PayPal capture check: failed to update the claim", {
        paymentIntentId: args.paymentIntentId,
        state,
        error: result.error,
      });
    }
  }
}
