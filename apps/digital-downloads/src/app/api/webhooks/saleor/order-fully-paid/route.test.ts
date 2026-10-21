// @vitest-environment node
/**
 * Regression NR-03: ORDER_FULLY_PAID must reject webhooks whose Saleor signature does not verify.
 *
 * The test drives the real route (SDK SaleorAsyncWebhook + HttpsEnforcingAPL + use case) and only
 * replaces the outer boundaries: the APL storage, the Saleor JWKS endpoint (global fetch), the
 * DynamoDB token repo, the Saleor product-attributes query and the email sender.
 * Signatures are real RS256 detached JWS (RFC 7797, b64=false), the format Saleor sends.
 */
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";

import type { AuthData } from "@saleor/app-sdk/APL";
import { ok } from "neverthrow";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  aplStore: new Map<string, AuthData>(),
  save: vi.fn(),
  sendEmail: vi.fn(),
  fetchProductAttributes: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  env: {
    NODE_ENV: "test",
    SECRET_KEY: "<test-secret-key>",
    DYNAMODB_MAIN_TABLE_NAME: "test-table",
    APL: "file",
    APP_API_BASE_URL: "https://downloads.example.test",
    DOWNLOAD_TOKEN_EXPIRY_HOURS: null,
    MAX_DOWNLOAD_LIMIT: null,
    EMAIL_ENABLED: true,
    ADMIN_EMAIL: undefined,
  },
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.loggerWarn,
    error: vi.fn(),
  }),
}));

// In-memory APL storage, wrapped by the app's real HttpsEnforcingAPL (as in src/lib/saleor-app.ts).
vi.mock("@/lib/saleor-app", async () => {
  const { HttpsEnforcingAPL } = await import("@/lib/https-enforcing-apl");

  const apl = new HttpsEnforcingAPL({
    get: async (saleorApiUrl) => mocks.aplStore.get(saleorApiUrl),
    set: async (authData) => {
      mocks.aplStore.set(authData.saleorApiUrl, authData);
    },
    delete: async (saleorApiUrl) => {
      mocks.aplStore.delete(saleorApiUrl);
    },
    getAll: async () => [...mocks.aplStore.values()],
  });

  return { apl, saleorApp: { apl } };
});

vi.mock("@/modules/download-tokens/repositories/download-token-repo-impl", () => ({
  downloadTokenRepoImpl: {
    save: mocks.save,
    getByToken: vi.fn(),
    incrementDownloadCount: vi.fn(),
    delete: vi.fn(),
    listByOrder: vi.fn(),
  },
}));

vi.mock("@/app/api/webhooks/saleor/order-fully-paid/fetch-product-attributes", () => ({
  fetchProductAttributes: mocks.fetchProductAttributes,
}));

vi.mock("@/modules/email/email-sender", () => ({
  emailSender: { sendEmail: mocks.sendEmail },
}));

import { POST } from "./route";

const REGISTERED_SALEOR_API_URL = "https://saleor-api.sonicdrivestudio.com/graphql/";
const REGISTERED_JWKS_URL = "https://saleor-api.sonicdrivestudio.com/.well-known/jwks.json";
const APP_ID = "QXBwOjE2";
const KID = "saleor-test-kid";

type KeyPair = { privateKey: KeyObject; jwks: string };

const createKeyPair = (kid: string): KeyPair => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });

  return {
    privateKey,
    jwks: JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }),
  };
};

// Saleor's key and an attacker's key (attacker reuses Saleor's public kid).
const saleorKeys = createKeyPair(KID);
const attackerKeys = createKeyPair(KID);

/** Detached JWS over the raw body, header {alg, kid, b64:false, crit:["b64"]} like Saleor's jws_encode. */
const signDetached = (rawBody: string, privateKey: KeyObject, kid = KID) => {
  const protectedHeader = Buffer.from(
    JSON.stringify({ alg: "RS256", kid, b64: false, crit: ["b64"] }),
  ).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${protectedHeader}.${rawBody}`), privateKey);

  return `${protectedHeader}..${signature.toString("base64url")}`;
};

const buildPayload = (overrides: { email?: string; recipientId?: string } = {}) => ({
  recipient: { id: overrides.recipientId ?? APP_ID },
  order: {
    id: "T3JkZXI6NTI5",
    number: "529",
    created: "2026-10-19T10:00:00+00:00",
    userEmail: overrides.email ?? "buyer@example.com",
    metadata: [],
    user: null,
    totalPrice: { gross: { amount: 19.9, currency: "EUR" } },
    lines: [
      {
        id: "T3JkZXJMaW5lOjE=",
        productName: "Sample Pack",
        variantName: "Digital",
        variant: {
          id: "UHJvZHVjdFZhcmlhbnQ6MQ==",
          name: "Digital",
          attributes: [],
          media: [],
          metadata: [],
          product: {
            id: "UHJvZHVjdDox",
            name: "Sample Pack",
            metadata: [],
            attributes: [],
            media: [],
            productType: {
              id: "UHJvZHVjdFR5cGU6MQ==",
              name: "Digital pack",
              metadata: [{ key: "digital_download", value: "true" }],
            },
          },
        },
      },
    ],
  },
});

const buildRequest = ({
  rawBody,
  signature,
  saleorApiUrl = REGISTERED_SALEOR_API_URL,
}: {
  rawBody: string;
  signature?: string;
  saleorApiUrl?: string;
}) => {
  const headers = new Headers({
    "content-type": "application/json",
    host: "downloads.example.test",
    "x-forwarded-proto": "https",
    "saleor-api-url": saleorApiUrl,
    "saleor-event": "order_fully_paid",
  });

  if (signature !== undefined) {
    headers.set("saleor-signature", signature);
  }

  return new NextRequest("https://downloads.example.test/api/webhooks/saleor/order-fully-paid", {
    method: "POST",
    headers,
    body: rawBody,
  });
};

const jwksResponse = (jwks: string) =>
  new Response(jwks, { status: 200, headers: { "content-type": "application/json" } });

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  mocks.aplStore.clear();
  mocks.aplStore.set(REGISTERED_SALEOR_API_URL, {
    saleorApiUrl: REGISTERED_SALEOR_API_URL,
    appId: APP_ID,
    token: "<app-token>",
    jwks: saleorKeys.jwks,
  });

  mocks.save.mockImplementation(async (token: unknown) => ok(token));
  mocks.sendEmail.mockImplementation(async () => ok(undefined));
  mocks.fetchProductAttributes.mockImplementation(async () =>
    ok([
      {
        attribute: { id: "QXR0cmlidXRlOjE=", name: "Files", slug: "files" },
        values: [
          {
            id: "QXR0cmlidXRlVmFsdWU6MQ==",
            name: "pack.zip",
            slug: "pack-zip",
            file: {
              url: "https://saleor-api.sonicdrivestudio.com/media/file_upload/pack.zip",
              contentType: "application/zip",
            },
          },
        ],
      },
    ]),
  );

  // Saleor's JWKS endpoint (used by the SDK when the cached JWKS does not verify).
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    jwksResponse(saleorKeys.jwks),
  );
});

describe("ORDER_FULLY_PAID webhook signature verification", () => {
  describe("valid Saleor signature", () => {
    it("creates download tokens and emails the buyer", async () => {
      const rawBody = JSON.stringify(buildPayload());

      const response = await POST(
        buildRequest({ rawBody, signature: signDetached(rawBody, saleorKeys.privateKey) }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ tokensCreated: 1 });
      expect(mocks.save).toHaveBeenCalledTimes(1);
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: "T3JkZXI6NTI5", customerEmail: "buyer@example.com" }),
      );
      expect(mocks.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "buyer@example.com" }),
      );
      // Cached JWKS verified: no network call needed.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("refreshes a stale cached JWKS from the registered Saleor over HTTPS, then proceeds", async () => {
      const staleKeys = createKeyPair("old-kid");

      mocks.aplStore.set(REGISTERED_SALEOR_API_URL, {
        saleorApiUrl: REGISTERED_SALEOR_API_URL,
        appId: APP_ID,
        token: "<app-token>",
        jwks: staleKeys.jwks,
      });

      const rawBody = JSON.stringify(buildPayload());

      const response = await POST(
        buildRequest({ rawBody, signature: signDetached(rawBody, saleorKeys.privateKey) }),
      );

      expect(response.status).toBe(200);
      expect(mocks.save).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(REGISTERED_JWKS_URL);
      expect(mocks.aplStore.get(REGISTERED_SALEOR_API_URL)?.jwks).toBe(saleorKeys.jwks);
    });

    it("accepts the http:// form of the registered API URL (HttpsEnforcingAPL scheme folding)", async () => {
      const rawBody = JSON.stringify(buildPayload());

      const response = await POST(
        buildRequest({
          rawBody,
          signature: signDetached(rawBody, saleorKeys.privateKey),
          saleorApiUrl: "http://saleor-api.sonicdrivestudio.com/graphql/",
        }),
      );

      expect(response.status).toBe(200);
      expect(mocks.save).toHaveBeenCalledTimes(1);
    });
  });

  describe("forged or invalid signature", () => {
    const expectRejected = async (response: Response) => {
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { type: "SIGNATURE_VERIFICATION_FAILED" },
      });
      expect(mocks.save).not.toHaveBeenCalled();
      expect(mocks.sendEmail).not.toHaveBeenCalled();
      expect(mocks.fetchProductAttributes).not.toHaveBeenCalled();
    };

    it("rejects a payload signed with an attacker's key (same kid), without creating tokens", async () => {
      const rawBody = JSON.stringify(buildPayload({ email: "attacker@example.com" }));

      const response = await POST(
        buildRequest({ rawBody, signature: signDetached(rawBody, attackerKeys.privateKey) }),
      );

      await expectRejected(response);
      // Second chance uses keys fetched from the REGISTERED Saleor, never from the request.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(REGISTERED_JWKS_URL);
      // The cached JWKS is not replaced after a failed verification.
      expect(mocks.aplStore.get(REGISTERED_SALEOR_API_URL)?.jwks).toBe(saleorKeys.jwks);
    });

    it("rejects a genuine signature replayed over a tampered body", async () => {
      const genuineBody = JSON.stringify(buildPayload());
      const tamperedBody = JSON.stringify(buildPayload({ email: "attacker@example.com" }));

      const response = await POST(
        buildRequest({
          rawBody: tamperedBody,
          signature: signDetached(genuineBody, saleorKeys.privateKey),
        }),
      );

      await expectRejected(response);
    });

    it("rejects a garbage signature header", async () => {
      const rawBody = JSON.stringify(buildPayload({ email: "attacker@example.com" }));

      const response = await POST(buildRequest({ rawBody, signature: "forged.signature.value" }));

      await expectRejected(response);
    });

    it("rejects a forged signature sent with the http:// form of the registered API URL", async () => {
      const rawBody = JSON.stringify(buildPayload({ email: "attacker@example.com" }));

      const response = await POST(
        buildRequest({
          rawBody,
          signature: signDetached(rawBody, attackerKeys.privateKey),
          saleorApiUrl: "http://saleor-api.sonicdrivestudio.com/graphql/",
        }),
      );

      await expectRejected(response);
      expect(fetchSpy).toHaveBeenCalledWith(REGISTERED_JWKS_URL);
    });

    it("rejects when the JWKS endpoint cannot be reached and the cached JWKS does not verify", async () => {
      fetchSpy.mockRejectedValue(new Error("network down"));

      const rawBody = JSON.stringify(buildPayload({ email: "attacker@example.com" }));

      const response = await POST(
        buildRequest({ rawBody, signature: signDetached(rawBody, attackerKeys.privateKey) }),
      );

      await expectRejected(response);
    });

    it("logs the rejection so it is visible in the app logs", async () => {
      const rawBody = JSON.stringify(buildPayload({ email: "attacker@example.com" }));

      await POST(
        buildRequest({ rawBody, signature: signDetached(rawBody, attackerKeys.privateKey) }),
      );

      expect(mocks.loggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("ORDER_FULLY_PAID webhook rejected"),
        expect.objectContaining({ errorType: "SIGNATURE_VERIFICATION_FAILED" }),
      );
    });
  });

  describe("requests that never reach signature verification", () => {
    it("rejects a missing signature header with 400", async () => {
      const rawBody = JSON.stringify(buildPayload({ email: "attacker@example.com" }));

      const response = await POST(buildRequest({ rawBody }));

      expect(response.status).toBe(400);
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("rejects an unregistered saleor-api-url (attacker-controlled Saleor) without fetching its JWKS", async () => {
      const rawBody = JSON.stringify(buildPayload({ email: "attacker@example.com" }));

      fetchSpy.mockImplementation(async () => jwksResponse(attackerKeys.jwks));

      const response = await POST(
        buildRequest({
          rawBody,
          signature: signDetached(rawBody, attackerKeys.privateKey),
          saleorApiUrl: "https://evil.example.com/graphql/",
        }),
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ error: { type: "NOT_REGISTERED" } });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("rejects a lookalike host that only differs from the registered one by subdomain", async () => {
      const rawBody = JSON.stringify(buildPayload({ email: "attacker@example.com" }));

      const response = await POST(
        buildRequest({
          rawBody,
          signature: signDetached(rawBody, attackerKeys.privateKey),
          saleorApiUrl: "https://saleor-api.sonicdrivestudio.com.evil.example/graphql/",
        }),
      );

      expect(response.status).toBe(401);
      expect(mocks.save).not.toHaveBeenCalled();
    });
  });
});
