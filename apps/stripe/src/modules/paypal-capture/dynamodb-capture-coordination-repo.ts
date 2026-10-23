import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { err, ok, Result } from "neverthrow";

import { DynamoMainTable } from "@/modules/dynamodb/dynamo-main-table";

import {
  CAPTURE_CLAIM_STATES,
  CaptureClaim,
  CaptureClaimState,
  CaptureCoordinationAccess,
  CaptureCoordinationRepoError,
  ICaptureCoordinationRepo,
} from "./capture-coordination-repo";

/** One lease for the whole app process fleet: the sweeper iterates every installation. */
export const CAPTURE_SWEEP_LEASE_KEY = { PK: "PAYPAL_CAPTURE_WORKER", SK: "SWEEP_LEASE" } as const;

const claimKey = (access: CaptureCoordinationAccess, paymentIntentId: string) => ({
  PK: DynamoMainTable.getPrimaryKeyScopedToInstallation(access),
  SK: `PAYPAL_CAPTURE_CLAIM#${paymentIntentId}`,
});

const isConditionFailure = (error: unknown) =>
  error instanceof ConditionalCheckFailedException ||
  (error instanceof Error && error.name === "ConditionalCheckFailedException");

const repoError = (message: string, cause: unknown) =>
  new CaptureCoordinationRepoError(message, { cause });

const isClaimState = (value: unknown): value is CaptureClaimState =>
  typeof value === "string" && (CAPTURE_CLAIM_STATES as ReadonlyArray<string>).includes(value);

const toClaim = (
  attributes: Record<string, unknown> | undefined,
): Result<CaptureClaim, InstanceType<typeof CaptureCoordinationRepoError>> => {
  const state = attributes?.claimState;

  if (!attributes || typeof attributes.paymentIntentId !== "string" || !isClaimState(state)) {
    return err(repoError("Unreadable capture claim", attributes));
  }

  const count = (value: unknown) => (typeof value === "number" ? value : 0);

  return ok({
    paymentIntentId: attributes.paymentIntentId,
    state,
    chargeAttempts: count(attributes.chargeAttempts),
    cancelAttempts: count(attributes.cancelAttempts),
    lastRequestAtMs: typeof attributes.lastRequestAt === "number" ? attributes.lastRequestAt : null,
    firstCheckedAtMs: typeof attributes.firstCheckedAt === "number" ? attributes.firstCheckedAt : null,
    holdReason: typeof attributes.holdReason === "string" ? attributes.holdReason : null,
  });
};

/**
 * A3d lease and claims as DynamoDB conditional updates on the main table (no new table, no
 * schema: plain attributes next to the existing items).
 */
export class DynamoDBCaptureCoordinationRepo implements ICaptureCoordinationRepo {
  private documentClient: Pick<DynamoDBDocumentClient, "send">;
  private tableName: string;

  constructor(deps: { documentClient: Pick<DynamoDBDocumentClient, "send">; tableName: string }) {
    this.documentClient = deps.documentClient;
    this.tableName = deps.tableName;
  }

  async acquireSweepLease(args: { holderId: string; nowMs: number; ttlMs: number }) {
    try {
      await this.documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: CAPTURE_SWEEP_LEASE_KEY,
          UpdateExpression: "SET holderId = :me, expiresAt = :expiresAt, updatedAt = :now",
          ConditionExpression: "attribute_not_exists(PK) OR expiresAt < :now OR holderId = :me",
          ExpressionAttributeValues: {
            ":me": args.holderId,
            ":expiresAt": args.nowMs + args.ttlMs,
            ":now": args.nowMs,
          },
        }),
      );

      return ok(true);
    } catch (error) {
      if (isConditionFailure(error)) {
        return ok(false);
      }

      return err(repoError("Failed to acquire the capture sweep lease", error));
    }
  }

  async lockClaim(args: {
    access: CaptureCoordinationAccess;
    paymentIntentId: string;
    holderId: string;
    nowMs: number;
    lockMs: number;
  }) {
    try {
      const result = await this.documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: claimKey(args.access, args.paymentIntentId),
          UpdateExpression:
            "SET lockHolder = :me, lockExpiresAt = :lockExpiresAt, paymentIntentId = :pi, updatedAt = :now, claimState = if_not_exists(claimState, :open), chargeAttempts = if_not_exists(chargeAttempts, :zero), cancelAttempts = if_not_exists(cancelAttempts, :zero), firstCheckedAt = if_not_exists(firstCheckedAt, :now)",
          /*
           * Review P2: no 'OR lockHolder = :me'. Each check locks with a token of its own, and a
           * valid lock refuses every other check, also one of the same process.
           */
          ConditionExpression:
            "attribute_not_exists(PK) OR attribute_not_exists(lockHolder) OR lockExpiresAt < :now",
          ExpressionAttributeValues: {
            ":me": args.holderId,
            ":lockExpiresAt": args.nowMs + args.lockMs,
            ":pi": args.paymentIntentId,
            ":now": args.nowMs,
            ":open": "open",
            ":zero": 0,
          },
          ReturnValues: "ALL_NEW",
        }),
      );

      return toClaim(result.Attributes);
    } catch (error) {
      if (isConditionFailure(error)) {
        return ok(null);
      }

      return err(repoError("Failed to lock the capture claim", error));
    }
  }

  async recordRequest(args: {
    access: CaptureCoordinationAccess;
    paymentIntentId: string;
    holderId: string;
    action: "charge" | "cancel";
    nowMs: number;
  }) {
    const counter = args.action === "charge" ? "chargeAttempts" : "cancelAttempts";

    try {
      const result = await this.documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: claimKey(args.access, args.paymentIntentId),
          UpdateExpression: `SET claimState = :state, lastRequestAt = :now, updatedAt = :now ADD ${counter} :one`,
          ConditionExpression: "lockHolder = :me",
          ExpressionAttributeValues: {
            ":state": args.action === "charge" ? "charge-requested" : "cancel-requested",
            ":now": args.nowMs,
            ":one": 1,
            ":me": args.holderId,
          },
          ReturnValues: "ALL_NEW",
        }),
      );

      return toClaim(result.Attributes);
    } catch (error) {
      return err(repoError("Failed to record a capture request", error));
    }
  }

  async setClaimState(args: {
    access: CaptureCoordinationAccess;
    paymentIntentId: string;
    holderId: string;
    state: Extract<CaptureClaimState, "captured" | "released" | "held">;
    holdReason?: string;
    nowMs: number;
  }) {
    try {
      await this.documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: claimKey(args.access, args.paymentIntentId),
          UpdateExpression:
            args.holdReason === undefined
              ? "SET claimState = :state, updatedAt = :now"
              : "SET claimState = :state, holdReason = :holdReason, updatedAt = :now",
          ConditionExpression: "lockHolder = :me",
          ExpressionAttributeValues: {
            ":state": args.state,
            ...(args.holdReason === undefined ? {} : { ":holdReason": args.holdReason }),
            ":now": args.nowMs,
            ":me": args.holderId,
          },
        }),
      );

      return ok(undefined);
    } catch (error) {
      return err(repoError("Failed to update the capture claim", error));
    }
  }

  async unlockClaim(args: {
    access: CaptureCoordinationAccess;
    paymentIntentId: string;
    holderId: string;
  }) {
    try {
      await this.documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: claimKey(args.access, args.paymentIntentId),
          UpdateExpression: "REMOVE lockHolder, lockExpiresAt",
          ConditionExpression: "lockHolder = :me",
          ExpressionAttributeValues: { ":me": args.holderId },
        }),
      );

      return ok(undefined);
    } catch (error) {
      if (isConditionFailure(error)) {
        // The lock expired and another holder took it: nothing of ours to remove.
        return ok(undefined);
      }

      return err(repoError("Failed to unlock the capture claim", error));
    }
  }
}
