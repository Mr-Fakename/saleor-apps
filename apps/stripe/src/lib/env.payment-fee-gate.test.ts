import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * A3c §4: with PAYMENT_FEE_GATE=paypal, an invalid rate or variant must stop the app when
 * src/lib/env.ts loads (every route imports it, including the /api/manifest healthcheck), never
 * serve PayPal with a fee it cannot verify. Unset = the gate is off and nothing is required.
 */

const GATE_KEYS = [
  "PAYMENT_FEE_GATE",
  "PAYMENT_FEE_RATE_PERCENT",
  "PAYMENT_FEE_VARIANT_ID",
  "PAYMENT_FEE_METADATA_KEY",
] as const;

type GateEnv = Partial<Record<(typeof GATE_KEYS)[number], string>>;

// What the worker had before this file: restored after the last test.
const original: GateEnv = Object.fromEntries(GATE_KEYS.map((key) => [key, process.env[key]]));

const withGateEnv = (values: GateEnv) => {
  for (const key of GATE_KEYS) {
    vi.stubEnv(key, values[key]);
  }
};

const loadEnvModule = async () => {
  vi.resetModules();

  return import("./env");
};

const FEE_VARIANT_ID = "UHJvZHVjdFZhcmlhbnQ6NDQ5";

describe("src/lib/env.ts: PayPal-fee gate at boot (A3c)", () => {
  afterAll(() => {
    withGateEnv(original);
  });

  it("loads with the gate unset, as today", async () => {
    withGateEnv({});

    const { env } = await loadEnvModule();

    expect(env.PAYMENT_FEE_GATE).toBeUndefined();
  });

  it("loads with the gate empty (compose `${VAR:-}`)", async () => {
    withGateEnv({ PAYMENT_FEE_GATE: "" });

    await expect(loadEnvModule()).resolves.toBeDefined();
  });

  it("loads with a valid gate", async () => {
    withGateEnv({
      PAYMENT_FEE_GATE: "paypal",
      PAYMENT_FEE_RATE_PERCENT: "1.5",
      PAYMENT_FEE_VARIANT_ID: FEE_VARIANT_ID,
    });

    const { env } = await loadEnvModule();

    expect(env.PAYMENT_FEE_GATE).toBe("paypal");
    expect(env.PAYMENT_FEE_RATE_PERCENT).toBe("1.5");
    expect(env.PAYMENT_FEE_VARIANT_ID).toBe(FEE_VARIANT_ID);
  });

  it.each<{ case: string; env: GateEnv }>([
    {
      case: "the gate on without a rate",
      env: { PAYMENT_FEE_GATE: "paypal", PAYMENT_FEE_VARIANT_ID: FEE_VARIANT_ID },
    },
    {
      case: "the gate on with a rate that is not a number",
      env: {
        PAYMENT_FEE_GATE: "paypal",
        PAYMENT_FEE_RATE_PERCENT: "1,5",
        PAYMENT_FEE_VARIANT_ID: FEE_VARIANT_ID,
      },
    },
    {
      case: "the gate on with a rate above 100",
      env: {
        PAYMENT_FEE_GATE: "paypal",
        PAYMENT_FEE_RATE_PERCENT: "150",
        PAYMENT_FEE_VARIANT_ID: FEE_VARIANT_ID,
      },
    },
    {
      case: "the gate on without a variant",
      env: { PAYMENT_FEE_GATE: "paypal", PAYMENT_FEE_RATE_PERCENT: "1.5" },
    },
    {
      case: "the gate on with a variant that is not a ProductVariant ID",
      env: {
        PAYMENT_FEE_GATE: "paypal",
        PAYMENT_FEE_RATE_PERCENT: "1.5",
        PAYMENT_FEE_VARIANT_ID: "449",
      },
    },
    {
      case: "an unknown gate value",
      env: {
        PAYMENT_FEE_GATE: "card",
        PAYMENT_FEE_RATE_PERCENT: "1.5",
        PAYMENT_FEE_VARIANT_ID: FEE_VARIANT_ID,
      },
    },
  ])("fails to load with $case", async ({ env }) => {
    withGateEnv(env);

    await expect(loadEnvModule()).rejects.toThrow(/PAYMENT_FEE_/);
  });
});
