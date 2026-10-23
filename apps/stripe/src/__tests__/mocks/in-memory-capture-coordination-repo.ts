import { err, ok, Result } from "neverthrow";

import {
  CaptureClaim,
  CaptureClaimState,
  CaptureCoordinationAccess,
  CaptureCoordinationRepoError,
  ICaptureCoordinationRepo,
} from "@/modules/paypal-capture/capture-coordination-repo";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type StoredClaim = Mutable<CaptureClaim> & { lockHolder: string | null; lockExpiresAtMs: number | null };

/**
 * The DynamoDB conditions of DynamoDBCaptureCoordinationRepo, in memory, for the coordinator and
 * sweeper tests: a valid lock (or lease) of another holder refuses; an expired one is taken over.
 */
export class InMemoryCaptureCoordinationRepo implements ICaptureCoordinationRepo {
  lease: { holderId: string; expiresAtMs: number } | null = null;
  claims = new Map<string, StoredClaim>();
  failNext: "lease" | "lock" | "record" | null = null;

  private key(access: CaptureCoordinationAccess, paymentIntentId: string) {
    return `${access.saleorApiUrl}#${access.appId}#${paymentIntentId}`;
  }

  private publicClaim(claim: StoredClaim): CaptureClaim {
    return {
      paymentIntentId: claim.paymentIntentId,
      state: claim.state,
      chargeAttempts: claim.chargeAttempts,
      cancelAttempts: claim.cancelAttempts,
      lastRequestAtMs: claim.lastRequestAtMs,
      firstCheckedAtMs: claim.firstCheckedAtMs,
      holdReason: claim.holdReason,
    };
  }

  claimOf(access: CaptureCoordinationAccess, paymentIntentId: string): StoredClaim | undefined {
    return this.claims.get(this.key(access, paymentIntentId));
  }

  /** Another check (by default another process) holds the claim lock until `untilMs`. */
  lockByOther(
    access: CaptureCoordinationAccess,
    paymentIntentId: string,
    untilMs: number,
    lockHolder = "other-process",
  ) {
    const existing = this.claimOf(access, paymentIntentId);

    this.claims.set(this.key(access, paymentIntentId), {
      paymentIntentId,
      state: existing?.state ?? "open",
      chargeAttempts: existing?.chargeAttempts ?? 0,
      cancelAttempts: existing?.cancelAttempts ?? 0,
      lastRequestAtMs: existing?.lastRequestAtMs ?? null,
      firstCheckedAtMs: existing?.firstCheckedAtMs ?? null,
      holdReason: existing?.holdReason ?? null,
      lockHolder,
      lockExpiresAtMs: untilMs,
    });
  }

  private takeFailure(kind: "lease" | "lock" | "record") {
    if (this.failNext === kind) {
      this.failNext = null;

      return true;
    }

    return false;
  }

  async acquireSweepLease(args: {
    holderId: string;
    nowMs: number;
    ttlMs: number;
  }): Promise<Result<boolean, InstanceType<typeof CaptureCoordinationRepoError>>> {
    if (this.takeFailure("lease")) {
      return err(new CaptureCoordinationRepoError("DynamoDB unavailable"));
    }

    if (this.lease && this.lease.expiresAtMs >= args.nowMs && this.lease.holderId !== args.holderId) {
      return ok(false);
    }

    this.lease = { holderId: args.holderId, expiresAtMs: args.nowMs + args.ttlMs };

    return ok(true);
  }

  async lockClaim(args: {
    access: CaptureCoordinationAccess;
    paymentIntentId: string;
    holderId: string;
    nowMs: number;
    lockMs: number;
  }): Promise<Result<CaptureClaim | null, InstanceType<typeof CaptureCoordinationRepoError>>> {
    if (this.takeFailure("lock")) {
      return err(new CaptureCoordinationRepoError("DynamoDB unavailable"));
    }

    const key = this.key(args.access, args.paymentIntentId);
    const existing = this.claims.get(key);

    // As DynamoDB: a valid lock refuses every other check, the same holder included (review P2).
    if (existing?.lockHolder && (existing.lockExpiresAtMs ?? 0) >= args.nowMs) {
      return ok(null);
    }

    const claim: StoredClaim = {
      paymentIntentId: args.paymentIntentId,
      state: existing?.state ?? "open",
      chargeAttempts: existing?.chargeAttempts ?? 0,
      cancelAttempts: existing?.cancelAttempts ?? 0,
      lastRequestAtMs: existing?.lastRequestAtMs ?? null,
      firstCheckedAtMs: existing?.firstCheckedAtMs ?? args.nowMs,
      holdReason: existing?.holdReason ?? null,
      lockHolder: args.holderId,
      lockExpiresAtMs: args.nowMs + args.lockMs,
    };

    this.claims.set(key, claim);

    return ok(this.publicClaim(claim));
  }

  async recordRequest(args: {
    access: CaptureCoordinationAccess;
    paymentIntentId: string;
    holderId: string;
    action: "charge" | "cancel";
    nowMs: number;
  }): Promise<Result<CaptureClaim, InstanceType<typeof CaptureCoordinationRepoError>>> {
    const claim = this.claims.get(this.key(args.access, args.paymentIntentId));

    if (this.takeFailure("record") || !claim || claim.lockHolder !== args.holderId) {
      return err(new CaptureCoordinationRepoError("Claim not locked by this holder"));
    }

    claim.state = args.action === "charge" ? "charge-requested" : "cancel-requested";
    claim.lastRequestAtMs = args.nowMs;

    if (args.action === "charge") {
      claim.chargeAttempts += 1;
    } else {
      claim.cancelAttempts += 1;
    }

    return ok(this.publicClaim(claim));
  }

  async setClaimState(args: {
    access: CaptureCoordinationAccess;
    paymentIntentId: string;
    holderId: string;
    state: Extract<CaptureClaimState, "captured" | "released" | "held">;
    holdReason?: string;
    nowMs: number;
  }): Promise<Result<void, InstanceType<typeof CaptureCoordinationRepoError>>> {
    const claim = this.claims.get(this.key(args.access, args.paymentIntentId));

    if (!claim || claim.lockHolder !== args.holderId) {
      return err(new CaptureCoordinationRepoError("Claim not locked by this holder"));
    }

    claim.state = args.state;

    if (args.holdReason !== undefined) {
      claim.holdReason = args.holdReason;
    }

    return ok(undefined);
  }

  async unlockClaim(args: {
    access: CaptureCoordinationAccess;
    paymentIntentId: string;
    holderId: string;
  }): Promise<Result<void, InstanceType<typeof CaptureCoordinationRepoError>>> {
    const claim = this.claims.get(this.key(args.access, args.paymentIntentId));

    if (claim && claim.lockHolder === args.holderId) {
      claim.lockHolder = null;
      claim.lockExpiresAtMs = null;
    }

    return ok(undefined);
  }
}
