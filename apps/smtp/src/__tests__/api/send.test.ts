import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetIbanGuardAlertBudget } from "../../modules/iban-guard/iban-guard";
import handler from "../../pages/api/send";

// Mock nodemailer
const mockSendMail = vi.fn();

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: mockSendMail,
    })),
  },
}));

// Mock logger
vi.mock("../../logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Mock verifyJWT
const mockVerifyJWT = vi.fn();

vi.mock("@saleor/app-sdk/auth", () => ({
  verifyJWT: (...args: unknown[]) => mockVerifyJWT(...args),
}));

// Mock saleorApp APL
const mockAplGet = vi.fn();

vi.mock("../../saleor-app", () => ({
  saleorApp: {
    apl: {
      get: (...args: unknown[]) => mockAplGet(...args),
    },
  },
}));

// Mock headers constants
vi.mock("@saleor/app-sdk/headers", () => ({
  SALEOR_AUTHORIZATION_BEARER_HEADER: "saleor-authorization-bearer",
  SALEOR_API_URL_HEADER: "saleor-api-url",
}));

function createMockReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: "POST",
    headers: {
      "x-api-key": "test-secret",
    },
    body: {
      to: "user@example.com",
      subject: "Test Subject",
      html: "<h1>Hello</h1>",
    },
    ...overrides,
  } as unknown as NextApiRequest;
}

function createMockRes(): NextApiResponse & {
  _status: number;
  _json: unknown;
  _headers: Record<string, string>;
  _ended: boolean;
} {
  const res = {
    _status: 200,
    _json: null as unknown,
    _headers: {} as Record<string, string>,
    _ended: false,

    status(code: number) {
      res._status = code;

      return res;
    },

    json(data: unknown) {
      res._json = data;

      return res;
    },

    end() {
      res._ended = true;

      return res;
    },

    setHeader(name: string, value: string) {
      res._headers[name] = value;

      return res;
    },
  };

  return res as unknown as NextApiResponse & {
    _status: number;
    _json: unknown;
    _headers: Record<string, string>;
    _ended: boolean;
  };
}

describe("POST /api/send", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.EMAIL_BRIDGE_API_SECRET = "test-secret";
    process.env.EMAIL_BRIDGE_SMTP_HOST = "mailpit";
    process.env.EMAIL_BRIDGE_SMTP_PORT = "1025";
    process.env.EMAIL_BRIDGE_SMTP_FROM = "noreply@example.com";
    // Clean up optional vars that other tests may set
    delete process.env.EMAIL_BRIDGE_SMTP_USER;
    delete process.env.EMAIL_BRIDGE_SMTP_PASS;
    delete process.env.EMAIL_BRIDGE_SMTP_SECURE;
    mockSendMail.mockResolvedValue({ messageId: "test-message-id" });
  });

  it("returns 200 OK on GET (health check)", async () => {
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toStrictEqual({ status: "ok" });
  });

  it("returns 204 on OPTIONS preflight with CORS headers", async () => {
    const req = createMockReq({ method: "OPTIONS" });
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(204);
    expect(res._ended).toBe(true);
    expect(res._headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(res._headers["Access-Control-Allow-Methods"]).toBe("GET, POST, OPTIONS");
    expect(res._headers["Access-Control-Allow-Headers"]).toContain("X-API-Key");
    expect(res._headers["Access-Control-Allow-Headers"]).toContain("Content-Type");
  });

  it("sets CORS headers on all responses", async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res._headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("returns 405 for unsupported HTTP methods", async () => {
    const req = createMockReq({ method: "PUT" });
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(405);
    expect(res._json).toStrictEqual({ error: "Method not allowed" });
  });

  it("returns 401 when X-API-Key header is missing", async () => {
    const req = createMockReq({ headers: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._json).toStrictEqual({ error: "Unauthorized" });
  });

  it("returns 401 when X-API-Key does not match", async () => {
    const req = createMockReq({ headers: { "x-api-key": "wrong-key" } });
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._json).toStrictEqual({ error: "Unauthorized" });
  });

  it("returns 500 when EMAIL_BRIDGE_API_SECRET is not configured and no JWT", async () => {
    delete process.env.EMAIL_BRIDGE_API_SECRET;

    const req = createMockReq({ headers: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toStrictEqual({ error: "Email bridge not configured" });
  });

  it("authenticates successfully with correct API key", async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toStrictEqual({ success: true, messageId: "test-message-id" });
  });

  it("authenticates with valid Saleor JWT token", async () => {
    mockAplGet.mockResolvedValue({
      appId: "app-123",
      token: "app-token",
      saleorApiUrl: "https://saleor.example.com/graphql/",
    });
    mockVerifyJWT.mockResolvedValue(undefined);

    const req = createMockReq({
      headers: {
        "saleor-authorization-bearer": "valid-jwt-token",
        "saleor-api-url": "https://saleor.example.com/graphql/",
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockAplGet).toHaveBeenCalledWith("https://saleor.example.com/graphql/");
    expect(mockVerifyJWT).toHaveBeenCalledWith({
      appId: "app-123",
      token: "valid-jwt-token",
      saleorApiUrl: "https://saleor.example.com/graphql/",
    });
  });

  it("returns 401 when JWT is invalid", async () => {
    mockAplGet.mockResolvedValue({
      appId: "app-123",
      token: "app-token",
      saleorApiUrl: "https://saleor.example.com/graphql/",
    });
    mockVerifyJWT.mockRejectedValue(new Error("Invalid token"));

    const req = createMockReq({
      headers: {
        "saleor-authorization-bearer": "invalid-jwt",
        "saleor-api-url": "https://saleor.example.com/graphql/",
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._json).toStrictEqual({ error: "Unauthorized" });
  });

  it("returns 401 when Saleor API URL is not registered in APL", async () => {
    mockAplGet.mockResolvedValue(null);

    const req = createMockReq({
      headers: {
        "saleor-authorization-bearer": "some-token",
        "saleor-api-url": "https://unknown-saleor.example.com/graphql/",
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._json).toStrictEqual({ error: "Unauthorized" });
  });

  it("prefers API key auth when both API key and JWT are present", async () => {
    const req = createMockReq({
      headers: {
        "x-api-key": "test-secret",
        "saleor-authorization-bearer": "some-jwt",
        "saleor-api-url": "https://saleor.example.com/graphql/",
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockVerifyJWT).not.toHaveBeenCalled();
  });

  it("returns 400 when 'to' field is missing", async () => {
    const req = createMockReq({ body: { subject: "Test", html: "<p>Hi</p>" } });
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toStrictEqual({ error: "Missing required fields: to, subject, html" });
  });

  it("returns 400 when 'subject' field is missing", async () => {
    const req = createMockReq({ body: { to: "user@example.com", html: "<p>Hi</p>" } });
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toStrictEqual({ error: "Missing required fields: to, subject, html" });
  });

  it("returns 400 when 'html' field is missing", async () => {
    const req = createMockReq({ body: { to: "user@example.com", subject: "Test" } });
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toStrictEqual({ error: "Missing required fields: to, subject, html" });
  });

  it("returns 500 when SMTP host is not configured", async () => {
    delete process.env.EMAIL_BRIDGE_SMTP_HOST;

    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toStrictEqual({ error: "SMTP not configured" });
  });

  it("sends email and returns success with messageId", async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toStrictEqual({ success: true, messageId: "test-message-id" });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledWith({
      from: "noreply@example.com",
      to: "user@example.com",
      subject: "Test Subject",
      html: "<h1>Hello</h1>",
      // multipart/alternative: a text/plain part is derived from the HTML
      text: expect.any(String),
    });
  });

  it("passes correct SMTP settings to transporter", async () => {
    const nodemailer = await import("nodemailer");

    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(nodemailer.default.createTransport).toHaveBeenCalledWith({
      host: "mailpit",
      port: 1025,
      secure: false,
      requireTLS: true,
      tls: { minVersion: "TLSv1.2" },
      disableFileAccess: true,
      disableUrlAccess: true,
      auth: undefined,
    });
  });

  it("passes SMTP auth when credentials are configured", async () => {
    process.env.EMAIL_BRIDGE_SMTP_USER = "user";
    process.env.EMAIL_BRIDGE_SMTP_PASS = "pass";

    const nodemailer = await import("nodemailer");

    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(nodemailer.default.createTransport).toHaveBeenCalledWith({
      host: "mailpit",
      port: 1025,
      secure: false,
      requireTLS: true,
      tls: { minVersion: "TLSv1.2" },
      disableFileAccess: true,
      disableUrlAccess: true,
      auth: { user: "user", pass: "pass" },
    });
  });

  it.each([
    ["html", { path: "/etc/passwd" }],
    ["html", { href: "http://169.254.169.254/" }],
    ["to", ["a@example.com", "b@example.com"]],
    ["subject", 42],
  ] as Array<[string, unknown]>)("returns 400 when '%s' is not a string", async (field, value) => {
    const req = createMockReq({
      body: {
        to: "user@example.com",
        subject: "Test Subject",
        html: "<h1>Hello</h1>",
        [field]: value,
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(400);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  describe("IBAN guard", () => {
    const shopIbanEmail = "<p>IBAN : FR76 1020 6000 3298 7397 7946 448</p>";
    const foreignIbanEmail = "<p>Nos coordonnées ont changé. IBAN : DE89 3704 0044 0532 0130 00</p>";

    beforeEach(() => {
      resetIbanGuardAlertBudget();
      mockSendMail.mockResolvedValue({ messageId: "id" });
      process.env.IBAN_GUARD_ALERT_TO = "owner@example.com";
    });

    afterEach(() => {
      delete process.env.IBAN_GUARD_MODE;
      delete process.env.IBAN_GUARD_ALERT_TO;
    });

    it("sends the shop's own bank details untouched, in enforce mode too", async () => {
      process.env.IBAN_GUARD_MODE = "enforce";

      const req = createMockReq({
        body: { to: "user@example.com", subject: "Virement", html: shopIbanEmail },
      });
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(mockSendMail).toHaveBeenCalledOnce();
      expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "user@example.com" }));
    });

    it("monitor mode (default): sends the email, then alerts the owner", async () => {
      const req = createMockReq({
        body: { to: "user@example.com", subject: "Virement", html: foreignIbanEmail },
      });
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(mockSendMail).toHaveBeenCalledTimes(2);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "owner@example.com", from: "noreply@example.com" }),
      );
      expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "user@example.com" }));
    });

    it("enforce mode: refuses with 422 and only the alert goes out", async () => {
      process.env.IBAN_GUARD_MODE = "enforce";

      const req = createMockReq({
        body: { to: "user@example.com", subject: "Virement", html: foreignIbanEmail },
      });
      const res = createMockRes();

      await handler(req, res);

      expect(res._status).toBe(422);
      expect(mockSendMail).toHaveBeenCalledOnce();
      expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@example.com" }));
    });
  });

  it("sets secure=true when SMTP_SECURE is 'true'", async () => {
    process.env.EMAIL_BRIDGE_SMTP_SECURE = "true";

    const nodemailer = await import("nodemailer");

    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(nodemailer.default.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: true }),
    );
  });

  it("returns 500 with error message when SMTP send fails", async () => {
    mockSendMail.mockRejectedValue(new Error("Connection refused"));

    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toStrictEqual({ error: "Connection refused" });
  });

  it("returns generic error message for non-Error exceptions", async () => {
    mockSendMail.mockRejectedValue("some string error");

    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toStrictEqual({ error: "Unknown error" });
  });
});
