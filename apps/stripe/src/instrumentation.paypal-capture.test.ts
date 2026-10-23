import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * A3d: src/instrumentation.ts starts the capture worker in the Node.js runtime with the
 * PayPal-fee gate on, and never lets a worker failure stop the server (register() errors abort
 * the Next.js start).
 */

const { startPaypalCaptureWorkerFromEnv } = vi.hoisted(() => ({
  startPaypalCaptureWorkerFromEnv: vi.fn(),
}));

vi.mock("./instrumentations/paypal-capture-worker", () => ({ startPaypalCaptureWorkerFromEnv }));

const KEYS = ["NEXT_RUNTIME", "PAYMENT_FEE_GATE", "OTEL_ENABLED", "NEXT_PUBLIC_SENTRY_DSN", "INIT_DYNAMODB_ON_STARTUP"] as const;
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

const register = async (values: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const key of KEYS) {
    vi.stubEnv(key, values[key]);
  }
  vi.resetModules();

  const instrumentation = await import("./instrumentation");

  return instrumentation.register();
};

describe("instrumentation.register: A3d capture worker", () => {
  beforeEach(() => {
    startPaypalCaptureWorkerFromEnv.mockReset();
    startPaypalCaptureWorkerFromEnv.mockReturnValue(true);
  });

  afterAll(() => {
    for (const key of KEYS) {
      vi.stubEnv(key, original[key]);
    }
  });

  it("starts the worker in the Node.js runtime with the gate on", async () => {
    await register({ NEXT_RUNTIME: "nodejs", PAYMENT_FEE_GATE: "paypal" });

    expect(startPaypalCaptureWorkerFromEnv).toHaveBeenCalledOnce();
  });

  it.each<Partial<Record<(typeof KEYS)[number], string>>>([
    { NEXT_RUNTIME: "nodejs" },
    { NEXT_RUNTIME: "nodejs", PAYMENT_FEE_GATE: "" },
    { NEXT_RUNTIME: "edge", PAYMENT_FEE_GATE: "paypal" },
    { PAYMENT_FEE_GATE: "paypal" },
  ])("does not start it with %o", async (values) => {
    await register(values);

    expect(startPaypalCaptureWorkerFromEnv).not.toHaveBeenCalled();
  });

  it("never fails register() when the worker cannot start", async () => {
    startPaypalCaptureWorkerFromEnv.mockImplementation(() => {
      throw new Error("PAYMENT_FEE_RATE_PERCENT is misconfigured");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(register({ NEXT_RUNTIME: "nodejs", PAYMENT_FEE_GATE: "paypal" })).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
  });
});
