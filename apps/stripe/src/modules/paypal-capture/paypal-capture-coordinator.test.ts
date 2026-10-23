import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedSaleorAppId } from "@/__tests__/mocks/constants";
import { InMemoryCaptureCoordinationRepo } from "@/__tests__/mocks/in-memory-capture-coordination-repo";
import { MockedTransactionRecorder } from "@/__tests__/mocks/mocked-transaction-recorder";
import {
  A3D_GATE,
  A3D_TX_ID,
  a3dPaymentIntent,
  a3dRecord,
  a3dTransaction,
  FakeCaptureSaleor,
  FakeCaptureStripe,
} from "@/__tests__/mocks/paypal-capture-fixtures";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { createStripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";

import { CAPTURE_REQUEST_SETTLE_MS, PaypalCaptureCoordinator } from "./paypal-capture-coordinator";

/*
 * A3d capture coordinator: one check of one paypal-only PaymentIntent.
 *
 * NEW constraint (verified 2026-10-23): Saleor 3.22.74 re-sends a transaction-request webhook
 * with an EMPTY body (EventPayload.save_as_file() overwrites the file-only payload:
 * saleor/core/models.py:199-203, webhook/transport/utils.py:651-658). So when the app's charge
 * handler answers 503 (Stripe outcome unknown), Saleor's retry cannot capture, and the request
 * ends as a failure with no Stripe effect. The coordinator never relies on that retry: after the
 * settle window it re-reads the PaymentIntent, re-requests while it is still requires_capture
 * (3 attempts), then holds capture-stuck. A capture that did happen is seen as succeeded; the
 * Stripe payment_intent.succeeded webhook records CHARGE_SUCCESS.
 */

const PI = "pi_3Coordinator";
const ACCESS = { saleorApiUrl: mockedSaleorApiUrl, appId: mockedSaleorAppId };

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let clock: number;
let repo: InMemoryCaptureCoordinationRepo;
let recorder: MockedTransactionRecorder;
let stripe: FakeCaptureStripe;
let saleor: FakeCaptureSaleor;
let followUps: number[];
let coordinator: PaypalCaptureCoordinator;

const check = (trigger: "sweep" | "soon" | "follow-up" = "sweep") =>
  coordinator.checkPaymentIntent({
    access: ACCESS,
    stripe,
    saleor,
    paymentIntentId: createStripePaymentIntentId(PI),
    trigger,
    scheduleFollowUp: (delayMs) => followUps.push(delayMs),
  });

const advance = (ms: number) => {
  clock += ms;
};

const claim = () => repo.claimOf(ACCESS, PI);

describe("PaypalCaptureCoordinator (A3d)", () => {
  beforeEach(() => {
    clock = Date.parse("2026-10-23T10:00:00.000Z");
    repo = new InMemoryCaptureCoordinationRepo();
    recorder = new MockedTransactionRecorder();
    stripe = new FakeCaptureStripe();
    saleor = new FakeCaptureSaleor(a3dTransaction(PI));
    followUps = [];
    Object.values(logger).forEach((fn) => fn.mockReset());

    stripe.set(a3dPaymentIntent(PI));
    void recorder.recordTransaction(ACCESS, a3dRecord(PI));

    coordinator = new PaypalCaptureCoordinator({
      repo,
      transactionRecorder: recorder,
      gate: A3D_GATE,
      holderId: "worker-1",
      now: () => clock,
      logger,
    });
  });

  it("settles a request for 90 s, captures in at most 3 attempts", () => {
    expect(CAPTURE_REQUEST_SETTLE_MS).toBe(90_000);
  });

  describe("capture", () => {
    it("requests CHARGE of the order total through Saleor when the order passes the rules", async () => {
      const outcome = await check();

      expect(outcome).toStrictEqual({ action: "charge-requested", attempt: 1, delivered: true });
      expect(saleor.requests).toStrictEqual([{ action: "CHARGE", transactionId: A3D_TX_ID, amount: 101.5 }]);
      expect(claim()).toMatchObject({ state: "charge-requested", chargeAttempts: 1, lastRequestAtMs: clock, lockHolder: null });
      expect(followUps).toStrictEqual([CAPTURE_REQUEST_SETTLE_MS + 5_000]);
    });

    it("never calls Stripe to write: it only reads the PaymentIntent", async () => {
      const touched = new Set<string>();
      const watchedStripe = new Proxy(stripe, {
        get(target, property, receiver) {
          touched.add(String(property));

          const value = Reflect.get(target, property, receiver);

          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      await coordinator.checkPaymentIntent({
        access: ACCESS,
        stripe: watchedStripe,
        saleor,
        paymentIntentId: createStripePaymentIntentId(PI),
        trigger: "sweep",
      });

      expect([...touched]).toStrictEqual(["getPaymentIntent"]);
      expect(stripe.reads).toStrictEqual([PI]);
      expect(saleor.requests).toHaveLength(1);
    });

    it("marks the claim captured once Stripe shows the capture (the webhook records CHARGE_SUCCESS)", async () => {
      saleor.onCharge = () => stripe.update(PI, { status: "succeeded", amount_received: 101_50, amount_capturable: 0 });

      await check();
      advance(CAPTURE_REQUEST_SETTLE_MS);

      const outcome = await check("follow-up");

      expect(outcome).toStrictEqual({ action: "captured" });
      expect(claim()?.state).toBe("captured");
      expect(saleor.requests).toHaveLength(1);
    });

    it("waits inside the settle window after a request: no second request", async () => {
      await check();
      advance(30_000);

      expect(await check("soon")).toStrictEqual({ action: "waiting", reason: "request-settling" });
      expect(saleor.requests).toHaveLength(1);
    });
  });

  describe("no Saleor retry: the coordinator recovers by itself (empty-body retries)", () => {
    it("re-requests while the PaymentIntent is still requires_capture, 3 attempts, then holds capture-stuck", async () => {
      // Every charge request ends as a failure with no Stripe effect: 503, then an empty retry.
      saleor.onCharge = () => {};

      expect(await check()).toMatchObject({ action: "charge-requested", attempt: 1 });
      advance(CAPTURE_REQUEST_SETTLE_MS);
      expect(await check()).toMatchObject({ action: "charge-requested", attempt: 2 });
      advance(CAPTURE_REQUEST_SETTLE_MS);
      expect(await check()).toMatchObject({ action: "charge-requested", attempt: 3 });
      advance(CAPTURE_REQUEST_SETTLE_MS);

      const outcome = await check();

      expect(outcome).toStrictEqual({ action: "held", reason: "capture-stuck" });
      expect(saleor.requests.filter((r) => r.action === "CHARGE")).toHaveLength(3);
      expect(saleor.tags).toStrictEqual([
        { transactionId: A3D_TX_ID, reason: "capture-stuck", checkedAt: new Date(clock).toISOString() },
      ]);
      expect(claim()).toMatchObject({ state: "held", holdReason: "capture-stuck" });
      expect(logger.error).toHaveBeenCalled();
    });

    it("stops re-requesting as soon as a later attempt captured", async () => {
      let attempts = 0;

      saleor.onCharge = () => {
        attempts += 1;

        // The first request was lost (503, then an empty retry); the second one captured.
        if (attempts === 2) {
          stripe.update(PI, { status: "succeeded", amount_received: 101_50, amount_capturable: 0 });
        }
      };

      await check();
      advance(CAPTURE_REQUEST_SETTLE_MS);
      expect(await check()).toMatchObject({ action: "charge-requested", attempt: 2 });
      advance(CAPTURE_REQUEST_SETTLE_MS);

      expect(await check()).toStrictEqual({ action: "captured" });
      advance(CAPTURE_REQUEST_SETTLE_MS);
      expect(await check()).toStrictEqual({ action: "captured" });
      expect(saleor.requests).toHaveLength(2);
    });

    it("checks the rules again before a re-request: an order canceled meanwhile is released instead", async () => {
      await check();
      saleor.transaction = a3dTransaction(PI, {}, "CANCELED");
      advance(CAPTURE_REQUEST_SETTLE_MS);

      expect(await check()).toStrictEqual({ action: "cancel-requested", attempt: 1, delivered: true });
      expect(saleor.requests.map((r) => r.action)).toStrictEqual(["CHARGE", "CANCEL"]);
    });

    it("counts a request Saleor refused (the mutation failed) and tries again after the window", async () => {
      saleor.requestFails = true;

      expect(await check()).toStrictEqual({ action: "charge-requested", attempt: 1, delivered: false });
      expect(logger.error).toHaveBeenCalled();

      saleor.requestFails = false;
      advance(CAPTURE_REQUEST_SETTLE_MS);

      expect(await check()).toStrictEqual({ action: "charge-requested", attempt: 2, delivered: true });
    });
  });

  describe("release on cancel (OD1)", () => {
    beforeEach(() => {
      saleor.transaction = a3dTransaction(PI, {}, "CANCELED");
    });

    it("requests CANCEL through Saleor, then sees the PaymentIntent canceled", async () => {
      saleor.onCancel = () => stripe.update(PI, { status: "canceled", amount_capturable: 0 });

      expect(await check()).toStrictEqual({ action: "cancel-requested", attempt: 1, delivered: true });
      expect(saleor.requests).toStrictEqual([{ action: "CANCEL", transactionId: A3D_TX_ID }]);

      advance(CAPTURE_REQUEST_SETTLE_MS);

      expect(await check()).toStrictEqual({ action: "released", byApp: true });
      expect(claim()?.state).toBe("released");
    });

    it("holds release-stuck after 3 cancel requests with no Stripe effect", async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect(await check()).toMatchObject({ action: "cancel-requested", attempt });
        advance(CAPTURE_REQUEST_SETTLE_MS);
      }

      expect(await check()).toStrictEqual({ action: "held", reason: "release-stuck" });
      expect(saleor.requests).toHaveLength(3);
    });
  });

  describe("the authorization ended without an app request (S1: cancellation_reason is null either way)", () => {
    it("reports an expiry or a staff cancel as released, not by the app, at warn level", async () => {
      stripe.update(PI, { status: "canceled", amount_capturable: 0, cancellation_reason: null });

      expect(await check()).toStrictEqual({ action: "released", byApp: false });
      expect(logger.warn).toHaveBeenCalled();
      expect(saleor.requests).toStrictEqual([]);
    });

    it("reports a capture made elsewhere (staff in the Dashboard) as captured", async () => {
      stripe.update(PI, { status: "succeeded", amount_received: 101_50, amount_capturable: 0 });

      expect(await check()).toStrictEqual({ action: "captured" });
      expect(saleor.requests).toStrictEqual([]);
    });
  });

  describe("hold", () => {
    it("tags the transaction, logs an error and writes nothing to Stripe (tamper: fee swapped)", async () => {
      const transaction = a3dTransaction(PI);

      saleor.transaction = {
        ...transaction,
        order: transaction.order && {
          ...transaction.order,
          lines: [
            transaction.order.lines[0],
            { productVariantId: "UHJvZHVjdFZhcmlhbnQ6OTk=", quantity: 1, metadata: [], totalPrice: { gross: { amount: 1.5, currency: "EUR" } } },
          ],
        },
      };

      expect(await check()).toStrictEqual({ action: "held", reason: "fee-absent" });
      expect(saleor.requests).toStrictEqual([]);
      expect(saleor.tags).toStrictEqual([{ transactionId: A3D_TX_ID, reason: "fee-absent", checkedAt: new Date(clock).toISOString() }]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("HELD"),
        expect.objectContaining({ paymentIntentId: PI, transactionId: A3D_TX_ID, reason: "fee-absent", rule: "R12" }),
      );
      expect(claim()).toMatchObject({ state: "held", holdReason: "fee-absent" });
    });

    it("does not tag or log again once held (R5): staff decide", async () => {
      saleor.transaction = a3dTransaction(PI, { chargedAmount: { amount: 1, currency: "EUR" } });

      await check();
      logger.error.mockReset();

      expect(await check()).toStrictEqual({ action: "skipped", reason: "already-held" });
      expect(saleor.tags).toHaveLength(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("still reports the hold when the tag cannot be written, and retries the tag next time", async () => {
      saleor.transaction = a3dTransaction(PI, { chargedAmount: { amount: 1, currency: "EUR" } });
      saleor.tagFails = true;

      expect(await check()).toStrictEqual({ action: "held", reason: "ledger-mismatch" });

      saleor.tagFails = false;

      expect(await check()).toStrictEqual({ action: "held", reason: "ledger-mismatch" });
      expect(saleor.tags).toHaveLength(1);
    });
  });

  describe("waits and skips make no write", () => {
    it("waits while the checkout is not completed yet", async () => {
      saleor.transaction = a3dTransaction(PI, { order: null, checkout: { id: "Q2hlY2tvdXQ6YTNk" } });

      expect(await check()).toStrictEqual({ action: "waiting", reason: "checkout-not-completed" });
      expect(saleor.requests).toStrictEqual([]);
      expect(saleor.tags).toStrictEqual([]);
    });

    it("skips a PaymentIntent this installation never recorded", async () => {
      recorder.reset();

      expect(await check()).toStrictEqual({ action: "skipped", reason: "not-recorded" });
      expect(saleor.requests).toStrictEqual([]);
    });

    it("waits while the PaymentIntent is processing", async () => {
      stripe.update(PI, { status: "processing" });

      expect(await check()).toStrictEqual({ action: "waiting", reason: "processing" });
    });
  });

  describe("claims", () => {
    it("does nothing while another process holds the PaymentIntent's claim", async () => {
      repo.lockByOther(ACCESS, PI, clock + 30_000);

      expect(await check()).toStrictEqual({ action: "busy" });
      expect(stripe.reads).toStrictEqual([]);
      expect(saleor.requests).toStrictEqual([]);
    });

    it("takes over a claim whose lock expired (a crashed process)", async () => {
      repo.lockByOther(ACCESS, PI, clock - 1);

      expect(await check()).toMatchObject({ action: "charge-requested" });
    });

    it("releases its lock after every check", async () => {
      saleor.transaction = a3dTransaction(PI, { order: null, checkout: { id: "Q2hlY2tvdXQ6YTNk" } });

      await check();

      expect(claim()?.lockHolder).toBeNull();
    });

    it("does not request when the attempt cannot be recorded (never an uncounted request)", async () => {
      repo.failNext = "record";

      expect(await check()).toStrictEqual({ action: "error", during: "claim" });
      expect(saleor.requests).toStrictEqual([]);
    });
  });

  describe("errors make no write", () => {
    it.each<{ case: string; arrange: () => void; during: string }>([
      { case: "the claim store is down", arrange: () => (repo.failNext = "lock"), during: "claim" },
      { case: "Stripe cannot be read", arrange: () => (stripe.failReads = true), during: "stripe" },
      { case: "Saleor cannot be read", arrange: () => (saleor.fetchFails = true), during: "saleor" },
    ])("$case", async ({ arrange, during }) => {
      arrange();

      expect(await check()).toStrictEqual({ action: "error", during });
      expect(saleor.requests).toStrictEqual([]);
      expect(saleor.tags).toStrictEqual([]);
    });
  });
});
