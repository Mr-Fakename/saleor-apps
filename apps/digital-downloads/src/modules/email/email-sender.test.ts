import { describe, expect, it, vi, beforeEach } from "vitest";

import { EmailSender, EmailSenderErrors } from "./email-sender";

// Mock env module
const mockEnv = {
  EMAIL_ENABLED: true,
  SMTP_APP_URL: "http://smtp-app:3000",
  SMTP_APP_API_KEY: "test-api-key",
};

vi.mock("@/lib/env", () => ({
  env: new Proxy(
    {},
    {
      get(_, prop) {
        return (mockEnv as Record<string, unknown>)[prop as string];
      },
    },
  ),
}));

// Mock logger
vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();

vi.stubGlobal("fetch", mockFetch);

const validInput = {
  to: "user@example.com",
  subject: "Your download is ready",
  html: "<h1>Download your files</h1>",
};

describe("EmailSender", () => {
  let sender: EmailSender;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.EMAIL_ENABLED = true;
    mockEnv.SMTP_APP_URL = "http://smtp-app:3000";
    mockEnv.SMTP_APP_API_KEY = "test-api-key";
  });

  beforeEach(() => {
    sender = new EmailSender();
  });

  // --- Disabled / unconfigured scenarios ---

  it("returns ok without sending when EMAIL_ENABLED is false", async () => {
    mockEnv.EMAIL_ENABLED = false;

    const result = await sender.sendEmail(validInput);

    expect(result.isOk()).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns ok without sending when SMTP_APP_URL is missing", async () => {
    (mockEnv as Record<string, unknown>).SMTP_APP_URL = undefined;

    const result = await sender.sendEmail(validInput);

    expect(result.isOk()).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns ok without sending when SMTP_APP_API_KEY is missing", async () => {
    (mockEnv as Record<string, unknown>).SMTP_APP_API_KEY = undefined;

    const result = await sender.sendEmail(validInput);

    expect(result.isOk()).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // --- Successful sending ---

  it("sends email to SMTP App and returns ok on success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, messageId: "msg-123" }),
    });

    const result = await sender.sendEmail(validInput);

    expect(result.isOk()).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith("http://smtp-app:3000/api/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "test-api-key",
      },
      body: JSON.stringify({
        to: "user@example.com",
        subject: "Your download is ready",
        html: "<h1>Download your files</h1>",
      }),
    });
  });

  it("constructs correct URL from SMTP_APP_URL", async () => {
    mockEnv.SMTP_APP_URL = "https://smtp.example.com";

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, messageId: "msg-456" }),
    });

    await sender.sendEmail(validInput);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://smtp.example.com/api/send",
      expect.any(Object),
    );
  });

  // --- Error handling ---

  it("returns SendEmailError when SMTP App responds with non-ok status", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('{"error":"SMTP not configured"}'),
    });

    const result = await sender.sendEmail(validInput);

    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();

    expect(error).toBeInstanceOf(EmailSenderErrors.SendEmailError);
    expect(error.message).toContain("Failed to send email");
  });

  it("returns SendEmailError when SMTP App responds with 401", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"error":"Unauthorized"}'),
    });

    const result = await sender.sendEmail(validInput);

    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();

    expect(error).toBeInstanceOf(EmailSenderErrors.SendEmailError);
  });

  it("returns SendEmailError when fetch throws a network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await sender.sendEmail(validInput);

    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();

    expect(error).toBeInstanceOf(EmailSenderErrors.SendEmailError);
    expect(error.message).toContain("Failed to send email");
  });

  it("returns SendEmailError when fetch throws a non-Error", async () => {
    mockFetch.mockRejectedValue("string error");

    const result = await sender.sendEmail(validInput);

    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();

    expect(error).toBeInstanceOf(EmailSenderErrors.SendEmailError);
  });

  // --- Input passthrough ---

  it("does not include text field in the request body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, messageId: "msg-789" }),
    });

    await sender.sendEmail({
      ...validInput,
      text: "Plain text version",
    });

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body).toEqual({
      to: "user@example.com",
      subject: "Your download is ready",
      html: "<h1>Download your files</h1>",
    });
    expect(body.text).toBeUndefined();
  });
});
