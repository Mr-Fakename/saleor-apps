import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * A3d wiring: the routes get a capture trigger only with the PayPal-fee gate on. Gate off (SDS,
 * rollback): no trigger, no runtime, nothing scheduled: the routes behave as today.
 */

const KEYS = ["PAYMENT_FEE_GATE", "PAYMENT_FEE_RATE_PERCENT", "PAYMENT_FEE_VARIANT_ID", "PAYMENT_FEE_PAYPAL_CAPTURE"] as const;
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

/** A cold import of the whole wiring (AWS SDK, Stripe, Saleor clients) after resetModules. */
const COLD_IMPORT_TIMEOUT_MS = 30_000;

const load = async (values: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const key of KEYS) {
    vi.stubEnv(key, values[key]);
  }
  vi.resetModules();

  return import("./paypal-capture-runtime");
};

describe("paypal-capture-runtime (A3d)", () => {
  afterAll(() => {
    for (const key of KEYS) {
      vi.stubEnv(key, original[key]);
    }
  });

  it("gives no trigger with the gate off", async () => {
    const registry: Record<string, unknown> = {};
    const runtime = await load({});

    expect(runtime.getPaypalCaptureTrigger(registry)).toBeNull();
    expect(Object.keys(registry)).toStrictEqual([]);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("gives one shared trigger per process with the gate on, without starting the worker", async () => {
    const registry: Record<string, unknown> = {};
    const runtime = await load({
      PAYMENT_FEE_GATE: "paypal",
      PAYMENT_FEE_RATE_PERCENT: "1.5",
      PAYMENT_FEE_VARIANT_ID: "UHJvZHVjdFZhcmlhbnQ6NDQ5",
    });

    const first = runtime.getPaypalCaptureTrigger(registry);
    const second = runtime.getPaypalCaptureTrigger(registry);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(runtime.getPaypalCaptureRuntime(registry)?.worker.isStarted()).toBe(false);

    runtime.getPaypalCaptureRuntime(registry)?.scheduler.stop();
  }, COLD_IMPORT_TIMEOUT_MS);
});
