import { Result } from "neverthrow";

import { BaseError } from "@/lib/errors";

/**
 * A3d coordination state, in the app's DynamoDB main table:
 * - the sweep lease: one sweeper at a time across processes (two containers during a deploy);
 * - one claim per PaymentIntent: a short lock (the sweep and a "soon" check never act on the
 *   same PaymentIntent together) and the count of capture / release requests made, which the
 *   no-retry recovery needs (Saleor 3.22.74 re-sends transaction requests with an empty body).
 *
 * The claim is bookkeeping: Stripe (the live PaymentIntent) and Saleor (the transaction and
 * its tags) stay the truth for every decision.
 */
export type CaptureClaimState =
  | "open"
  | "charge-requested"
  | "cancel-requested"
  | "captured"
  | "released"
  | "held";

export const CAPTURE_CLAIM_STATES: ReadonlyArray<CaptureClaimState> = [
  "open",
  "charge-requested",
  "cancel-requested",
  "captured",
  "released",
  "held",
];

export type CaptureClaim = {
  readonly paymentIntentId: string;
  readonly state: CaptureClaimState;
  /** transactionRequestAction(CHARGE) calls made for this PaymentIntent. */
  readonly chargeAttempts: number;
  /** transactionRequestAction(CANCEL) calls made for this PaymentIntent. */
  readonly cancelAttempts: number;
  /** When the last request was made (epoch ms), or null. */
  readonly lastRequestAtMs: number | null;
  readonly holdReason: string | null;
};

/** Claims are scoped to one app installation, like the RecordedTransaction. */
export type CaptureCoordinationAccess = {
  readonly saleorApiUrl: string;
  readonly appId: string;
};

export const CaptureCoordinationRepoError = BaseError.subclass("CaptureCoordinationRepoError", {
  props: {
    _internalName: "CaptureCoordinationRepoError" as const,
  },
});

type RepoResult<T> = Promise<Result<T, InstanceType<typeof CaptureCoordinationRepoError>>>;

export interface ICaptureCoordinationRepo {
  /**
   * Takes or renews the sweep lease. False while another holder's lease is valid; an expired
   * lease (a crashed process) is taken over.
   */
  acquireSweepLease(args: { holderId: string; nowMs: number; ttlMs: number }): RepoResult<boolean>;

  /**
   * Locks the PaymentIntent's claim for one check (creating it when new) and returns it, or
   * null while another holder's lock is valid.
   */
  lockClaim(args: {
    access: CaptureCoordinationAccess;
    paymentIntentId: string;
    holderId: string;
    nowMs: number;
    lockMs: number;
  }): RepoResult<CaptureClaim | null>;

  /** Counts a request, under this holder's lock, BEFORE it is sent (never an uncounted one). */
  recordRequest(args: {
    access: CaptureCoordinationAccess;
    paymentIntentId: string;
    holderId: string;
    action: "charge" | "cancel";
    nowMs: number;
  }): RepoResult<CaptureClaim>;

  setClaimState(args: {
    access: CaptureCoordinationAccess;
    paymentIntentId: string;
    holderId: string;
    state: Extract<CaptureClaimState, "captured" | "released" | "held">;
    holdReason?: string;
    nowMs: number;
  }): RepoResult<void>;

  /** Removes this holder's lock; a lock that expired and was taken over is left alone. */
  unlockClaim(args: {
    access: CaptureCoordinationAccess;
    paymentIntentId: string;
    holderId: string;
  }): RepoResult<void>;
}
