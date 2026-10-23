import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockedSaleorAppId } from "@/__tests__/mocks/constants";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";

import { CaptureCheckScheduler, SOON_CHECK_DELAYS_MS } from "./capture-check-scheduler";

/*
 * A3d "soon" checks: after the app reports AUTHORIZATION_SUCCESS for a paypal-only PaymentIntent
 * (Stripe webhook amount_capturable_updated, or process-session), the PaymentIntent is checked at
 * +15, +45 and +120 s, so a normal order is captured within about a minute instead of waiting for
 * the sweep (whose Stripe search lags by up to a minute).
 */

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const authorization = (paymentIntentId = "pi_3Soon", policy = "paypal-only") => ({
  saleorApiUrl: mockedSaleorApiUrl,
  appId: mockedSaleorAppId,
  paymentIntent: { id: paymentIntentId, metadata: { saleor_payment_policy: policy } },
  stripeConfig: { configId: "config-1" },
});

const target = (paymentIntentId = "pi_3Soon") => ({
  saleorApiUrl: mockedSaleorApiUrl,
  appId: mockedSaleorAppId,
  paymentIntentId,
  stripeConfig: { configId: "config-1" },
});

describe("CaptureCheckScheduler (A3d soon trigger)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks at +15, +45 and +120 s", async () => {
    expect(SOON_CHECK_DELAYS_MS).toStrictEqual([15_000, 45_000, 120_000]);

    const runCheck = vi.fn(async () => undefined);
    const scheduler = new CaptureCheckScheduler({ runCheck, logger });

    scheduler.onAuthorizationSuccess(authorization());

    await vi.advanceTimersByTimeAsync(14_999);
    expect(runCheck).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runCheck.mock.calls).toStrictEqual([[target()]]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(runCheck).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(75_000);
    expect(runCheck).toHaveBeenCalledTimes(3);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it.each(["no-paypal", ""])("ignores a PaymentIntent with the policy %o (card authorizations are not ours)", async (policy) => {
    const runCheck = vi.fn(async () => undefined);
    const scheduler = new CaptureCheckScheduler({ runCheck, logger });

    scheduler.onAuthorizationSuccess(authorization("pi_3Card", policy));
    await vi.advanceTimersByTimeAsync(200_000);

    expect(runCheck).not.toHaveBeenCalled();
  });

  it("schedules one series per PaymentIntent (the webhook and process-session both report it)", async () => {
    const runCheck = vi.fn(async () => undefined);
    const scheduler = new CaptureCheckScheduler({ runCheck, logger });

    scheduler.onAuthorizationSuccess(authorization());
    scheduler.onAuthorizationSuccess(authorization());
    await vi.advanceTimersByTimeAsync(200_000);

    expect(runCheck).toHaveBeenCalledTimes(3);
  });

  it("schedules a new series once the previous one is over", async () => {
    const runCheck = vi.fn(async () => undefined);
    const scheduler = new CaptureCheckScheduler({ runCheck, logger });

    scheduler.onAuthorizationSuccess(authorization());
    await vi.advanceTimersByTimeAsync(200_000);
    scheduler.onAuthorizationSuccess(authorization());
    await vi.advanceTimersByTimeAsync(200_000);

    expect(runCheck).toHaveBeenCalledTimes(6);
  });

  it("keeps going when a check rejects", async () => {
    const runCheck = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const scheduler = new CaptureCheckScheduler({ runCheck, logger });

    scheduler.onAuthorizationSuccess(authorization());
    await vi.advanceTimersByTimeAsync(200_000);

    expect(runCheck).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalled();
  });

  it("bounds the pending timers (the sweep still covers what is dropped)", async () => {
    const runCheck = vi.fn(async () => undefined);
    const scheduler = new CaptureCheckScheduler({ runCheck, logger, maxPending: 2 });

    scheduler.onAuthorizationSuccess(authorization("pi_1"));
    scheduler.onAuthorizationSuccess(authorization("pi_2"));
    scheduler.onAuthorizationSuccess(authorization("pi_3"));

    expect(scheduler.pendingCount()).toBe(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("runs one follow-up check at the delay asked", async () => {
    const runCheck = vi.fn(async () => undefined);
    const scheduler = new CaptureCheckScheduler({ runCheck, logger });

    scheduler.scheduleFollowUp(target("pi_3Follow"), 95_000);
    await vi.advanceTimersByTimeAsync(94_999);
    expect(runCheck).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runCheck.mock.calls).toStrictEqual([[target("pi_3Follow")]]);
  });

  it("stop() cancels everything pending", async () => {
    const runCheck = vi.fn(async () => undefined);
    const scheduler = new CaptureCheckScheduler({ runCheck, logger });

    scheduler.onAuthorizationSuccess(authorization());
    scheduler.scheduleFollowUp(target("pi_3Follow"), 95_000);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(200_000);

    expect(runCheck).not.toHaveBeenCalled();
    expect(scheduler.pendingCount()).toBe(0);
  });
});
