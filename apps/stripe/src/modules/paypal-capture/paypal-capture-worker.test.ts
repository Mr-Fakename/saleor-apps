import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { A3D_GATE } from "@/__tests__/mocks/paypal-capture-fixtures";

import {
  PAYPAL_CAPTURE_FIRST_SWEEP_DELAY_MS,
  PAYPAL_CAPTURE_SWEEP_INTERVAL_MS,
  PaypalCaptureWorker,
  shouldStartPaypalCaptureWorker,
  startPaypalCaptureWorkerOnce,
} from "./paypal-capture-worker";

/*
 * A3d in-process worker, started from src/instrumentation.ts (register()). Spike S3
 * (2026-10-23, Next 15.5.28): register() runs once per server process, before "Ready", under
 * both `next start` and the standalone `node apps/stripe/server.js` the image runs, never during
 * `next build`; a setInterval set there keeps firing with or without requests.
 */

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("shouldStartPaypalCaptureWorker", () => {
  it.each<{ nextRuntime: string | undefined; gate: typeof A3D_GATE | null; expected: boolean }>([
    { nextRuntime: "nodejs", gate: A3D_GATE, expected: true },
    { nextRuntime: "nodejs", gate: null, expected: false },
    { nextRuntime: "edge", gate: A3D_GATE, expected: false },
    { nextRuntime: undefined, gate: A3D_GATE, expected: false },
  ])("runtime $nextRuntime, gate $gate -> $expected", ({ nextRuntime, gate, expected }) => {
    expect(shouldStartPaypalCaptureWorker({ nextRuntime, paymentFeeGate: gate })).toBe(expected);
  });
});

describe("PaypalCaptureWorker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.values(logger).forEach((fn) => fn.mockReset());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps once 30 s after start, then every 60 s", async () => {
    expect(PAYPAL_CAPTURE_FIRST_SWEEP_DELAY_MS).toBe(30_000);
    expect(PAYPAL_CAPTURE_SWEEP_INTERVAL_MS).toBe(60_000);

    const sweep = vi.fn(async () => undefined);
    const worker = new PaypalCaptureWorker({ sweep, logger });

    expect(worker.start()).toBe(true);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(sweep).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(sweep).toHaveBeenCalledTimes(4);

    worker.stop();
  });

  it("never runs two sweeps at once: a tick during a slow sweep is skipped", async () => {
    let finish: () => void = () => {};
    const sweep = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const worker = new PaypalCaptureWorker({ sweep, logger });

    worker.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);

    worker.stop();
  });

  it("keeps running after a sweep throws", async () => {
    const sweep = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const worker = new PaypalCaptureWorker({ sweep, logger });

    worker.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sweep).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();

    worker.stop();
  });

  it("starts once: a second start() is a no-op", async () => {
    const sweep = vi.fn(async () => undefined);
    const worker = new PaypalCaptureWorker({ sweep, logger });

    expect(worker.start()).toBe(true);
    expect(worker.start()).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sweep).toHaveBeenCalledTimes(1);

    worker.stop();
  });

  it("stops: no sweep after stop()", async () => {
    const sweep = vi.fn(async () => undefined);
    const worker = new PaypalCaptureWorker({ sweep, logger });

    worker.start();
    worker.stop();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(sweep).not.toHaveBeenCalled();
  });
});

describe("startPaypalCaptureWorkerOnce", () => {
  it("starts one worker per process, even if register() ran twice", () => {
    const registry: Record<string, unknown> = {};
    const start = vi.fn(() => true);
    const create = vi.fn(() => ({ start }) as unknown as PaypalCaptureWorker);

    expect(startPaypalCaptureWorkerOnce(create, registry)).toBe(true);
    expect(startPaypalCaptureWorkerOnce(create, registry)).toBe(false);
    expect(create).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });
});
