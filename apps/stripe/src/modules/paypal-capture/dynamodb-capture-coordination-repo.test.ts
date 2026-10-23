import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { mockedSaleorAppId } from "@/__tests__/mocks/constants";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";

import { CaptureCoordinationRepoError } from "./capture-coordination-repo";
import {
  CAPTURE_SWEEP_LEASE_KEY,
  DynamoDBCaptureCoordinationRepo,
} from "./dynamodb-capture-coordination-repo";

/*
 * A3d coordination: one sweeper at a time (lease) and one check per PaymentIntent at a time
 * (claim lock). Both are DynamoDB conditional updates on the app's main table, so two app
 * containers (a rolling deploy) or the sweep and a "soon" check never act on the same
 * PaymentIntent together.
 */

const documentClient = mockClient(DynamoDBDocumentClient);
const TABLE = "stripe-main-table";
const ACCESS = { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId };
const PI = "pi_3Claim";
const NOW = 1_800_000_000_000;

const createRepo = () =>
  new DynamoDBCaptureCoordinationRepo({
    documentClient,
    tableName: TABLE,
  });

const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });

const lastUpdate = () => {
  const calls = documentClient.commandCalls(UpdateCommand);

  return calls[calls.length - 1].args[0].input;
};

const claimKey = { PK: `${mockedSaleorApiUrl}#${mockedSaleorAppId}`, SK: `PAYPAL_CAPTURE_CLAIM#${PI}` };

describe("DynamoDBCaptureCoordinationRepo", () => {
  beforeEach(() => {
    documentClient.reset();
  });

  describe("acquireSweepLease", () => {
    it("takes the lease when it is free, expired or already ours", async () => {
      documentClient.on(UpdateCommand).resolves({});

      const result = await createRepo().acquireSweepLease({ holderId: "me", nowMs: NOW, ttlMs: 90_000 });

      expect(result._unsafeUnwrap()).toBe(true);
      expect(lastUpdate()).toStrictEqual({
        TableName: TABLE,
        Key: CAPTURE_SWEEP_LEASE_KEY,
        UpdateExpression: "SET holderId = :me, expiresAt = :expiresAt, updatedAt = :now",
        ConditionExpression: "attribute_not_exists(PK) OR expiresAt < :now OR holderId = :me",
        ExpressionAttributeValues: { ":me": "me", ":expiresAt": NOW + 90_000, ":now": NOW },
      });
    });

    it("answers false while another holder's lease is valid", async () => {
      documentClient.on(UpdateCommand).rejects(conditionFailed());

      const result = await createRepo().acquireSweepLease({ holderId: "me", nowMs: NOW, ttlMs: 90_000 });

      expect(result._unsafeUnwrap()).toBe(false);
    });

    it("returns an error when DynamoDB fails", async () => {
      documentClient.on(UpdateCommand).rejects(new Error("network"));

      const result = await createRepo().acquireSweepLease({ holderId: "me", nowMs: NOW, ttlMs: 90_000 });

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(CaptureCoordinationRepoError);
    });
  });

  describe("lockClaim", () => {
    it("creates or locks the claim and returns it", async () => {
      documentClient.on(UpdateCommand).resolves({
        Attributes: {
          paymentIntentId: PI,
          claimState: "charge-requested",
          chargeAttempts: 2,
          cancelAttempts: 0,
          lastRequestAt: NOW - 100_000,
          holdReason: null,
        },
      });

      const result = await createRepo().lockClaim({
        access: ACCESS,
        paymentIntentId: PI,
        holderId: "me",
        nowMs: NOW,
        lockMs: 60_000,
      });

      expect(result._unsafeUnwrap()).toStrictEqual({
        paymentIntentId: PI,
        state: "charge-requested",
        chargeAttempts: 2,
        cancelAttempts: 0,
        lastRequestAtMs: NOW - 100_000,
        holdReason: null,
      });
      expect(lastUpdate()).toStrictEqual({
        TableName: TABLE,
        Key: claimKey,
        UpdateExpression:
          "SET lockHolder = :me, lockExpiresAt = :lockExpiresAt, paymentIntentId = :pi, updatedAt = :now, claimState = if_not_exists(claimState, :open), chargeAttempts = if_not_exists(chargeAttempts, :zero), cancelAttempts = if_not_exists(cancelAttempts, :zero)",
        ConditionExpression:
          "attribute_not_exists(PK) OR attribute_not_exists(lockHolder) OR lockExpiresAt < :now OR lockHolder = :me",
        ExpressionAttributeValues: {
          ":me": "me",
          ":lockExpiresAt": NOW + 60_000,
          ":pi": PI,
          ":now": NOW,
          ":open": "open",
          ":zero": 0,
        },
        ReturnValues: "ALL_NEW",
      });
    });

    it("answers null (busy) while another holder's lock is valid", async () => {
      documentClient.on(UpdateCommand).rejects(conditionFailed());

      const result = await createRepo().lockClaim({
        access: ACCESS,
        paymentIntentId: PI,
        holderId: "me",
        nowMs: NOW,
        lockMs: 60_000,
      });

      expect(result._unsafeUnwrap()).toBeNull();
    });

    it("returns an error for an unreadable claim", async () => {
      documentClient.on(UpdateCommand).resolves({ Attributes: { paymentIntentId: PI, claimState: "nonsense" } });

      const result = await createRepo().lockClaim({
        access: ACCESS,
        paymentIntentId: PI,
        holderId: "me",
        nowMs: NOW,
        lockMs: 60_000,
      });

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(CaptureCoordinationRepoError);
    });
  });

  describe("recordRequest", () => {
    it.each([
      { action: "charge" as const, state: "charge-requested", counter: "chargeAttempts" },
      { action: "cancel" as const, state: "cancel-requested", counter: "cancelAttempts" },
    ])("counts a $action request under our lock", async ({ action, state, counter }) => {
      documentClient.on(UpdateCommand).resolves({
        Attributes: {
          paymentIntentId: PI,
          claimState: state,
          chargeAttempts: action === "charge" ? 1 : 0,
          cancelAttempts: action === "cancel" ? 1 : 0,
          lastRequestAt: NOW,
        },
      });

      const result = await createRepo().recordRequest({ access: ACCESS, paymentIntentId: PI, holderId: "me", action, nowMs: NOW });

      expect(result._unsafeUnwrap()).toMatchObject({ state, lastRequestAtMs: NOW });
      expect(lastUpdate()).toStrictEqual({
        TableName: TABLE,
        Key: claimKey,
        UpdateExpression: `SET claimState = :state, lastRequestAt = :now, updatedAt = :now ADD ${counter} :one`,
        ConditionExpression: "lockHolder = :me",
        ExpressionAttributeValues: { ":state": state, ":now": NOW, ":one": 1, ":me": "me" },
        ReturnValues: "ALL_NEW",
      });
    });

    it("refuses without our lock (never counts a request it did not make)", async () => {
      documentClient.on(UpdateCommand).rejects(conditionFailed());

      const result = await createRepo().recordRequest({ access: ACCESS, paymentIntentId: PI, holderId: "me", action: "charge", nowMs: NOW });

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(CaptureCoordinationRepoError);
    });
  });

  describe("setClaimState", () => {
    it("records a hold and its reason under our lock", async () => {
      documentClient.on(UpdateCommand).resolves({});

      await createRepo().setClaimState({
        access: ACCESS,
        paymentIntentId: PI,
        holderId: "me",
        state: "held",
        holdReason: "fee-absent",
        nowMs: NOW,
      });

      expect(lastUpdate()).toStrictEqual({
        TableName: TABLE,
        Key: claimKey,
        UpdateExpression: "SET claimState = :state, holdReason = :holdReason, updatedAt = :now",
        ConditionExpression: "lockHolder = :me",
        ExpressionAttributeValues: { ":state": "held", ":holdReason": "fee-absent", ":now": NOW, ":me": "me" },
      });
    });
  });

  describe("unlockClaim", () => {
    it("removes our lock", async () => {
      documentClient.on(UpdateCommand).resolves({});

      const result = await createRepo().unlockClaim({ access: ACCESS, paymentIntentId: PI, holderId: "me" });

      expect(result.isOk()).toBe(true);
      expect(lastUpdate()).toStrictEqual({
        TableName: TABLE,
        Key: claimKey,
        UpdateExpression: "REMOVE lockHolder, lockExpiresAt",
        ConditionExpression: "lockHolder = :me",
        ExpressionAttributeValues: { ":me": "me" },
      });
    });

    it("is fine when the lock is no longer ours (expired and taken)", async () => {
      documentClient.on(UpdateCommand).rejects(conditionFailed());

      const result = await createRepo().unlockClaim({ access: ACCESS, paymentIntentId: PI, holderId: "me" });

      expect(result.isOk()).toBe(true);
    });
  });
});
