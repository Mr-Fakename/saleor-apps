import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * A3d: PAYMENT_FEE_PAYPAL_CAPTURE is validated when src/lib/env.ts loads (every route imports
 * it, including the /api/manifest healthcheck): an unknown value stops the app at boot.
 */

const KEYS = [
  "PAYMENT_FEE_GATE",
  "PAYMENT_FEE_RATE_PERCENT",
  "PAYMENT_FEE_VARIANT_ID",
  "PAYMENT_FEE_METADATA_KEY",
  "PAYMENT_FEE_PAYPAL_CAPTURE",
] as const;

type CaptureEnv = Partial<Record<(typeof KEYS)[number], string>>;

const original: CaptureEnv = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

const withEnv = (values: CaptureEnv) => {
  for (const key of KEYS) {
    vi.stubEnv(key, values[key]);
  }
};

const loadEnvModule = async () => {
  vi.resetModules();

  return import("./env");
};

const GATE_ON = {
  PAYMENT_FEE_GATE: "paypal",
  PAYMENT_FEE_RATE_PERCENT: "1.5",
  PAYMENT_FEE_VARIANT_ID: "UHJvZHVjdFZhcmlhbnQ6NDQ5",
};

describe("src/lib/env.ts: PAYMENT_FEE_PAYPAL_CAPTURE at boot (A3d)", () => {
  afterAll(() => {
    withEnv(original);
  });

  it.each<CaptureEnv>([
    {},
    { PAYMENT_FEE_PAYPAL_CAPTURE: "manual" },
    { ...GATE_ON },
    { ...GATE_ON, PAYMENT_FEE_PAYPAL_CAPTURE: "manual" },
    { ...GATE_ON, PAYMENT_FEE_PAYPAL_CAPTURE: "automatic" },
    { ...GATE_ON, PAYMENT_FEE_PAYPAL_CAPTURE: "" },
  ])("loads with %o", async (values) => {
    withEnv(values);

    const { env } = await loadEnvModule();

    expect(env.PAYMENT_FEE_PAYPAL_CAPTURE).toBe(values.PAYMENT_FEE_PAYPAL_CAPTURE);
  });

  it.each<CaptureEnv>([
    { ...GATE_ON, PAYMENT_FEE_PAYPAL_CAPTURE: "auto" },
    { ...GATE_ON, PAYMENT_FEE_PAYPAL_CAPTURE: "Manual" },
    { PAYMENT_FEE_PAYPAL_CAPTURE: "off" },
  ])("fails to load with %o", async (values) => {
    withEnv(values);

    await expect(loadEnvModule()).rejects.toThrow(/PAYMENT_FEE_PAYPAL_CAPTURE/);
  });
});
