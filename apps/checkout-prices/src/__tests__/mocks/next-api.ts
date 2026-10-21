import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Minimal NextApiRequest/NextApiResponse doubles for Pages Router handler
 * tests (same approach as apps/smtp/src/__tests__/api/send.test.ts).
 */

export const APP_HOST = "checkout-prices.test";

export function createMockReq({
  method = "POST",
  headers = {},
  body,
}: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
} = {}): NextApiRequest {
  return {
    method,
    headers: { host: APP_HOST, ...headers },
    body,
  } as unknown as NextApiRequest;
}

export type MockRes = NextApiResponse & {
  _status: number;
  _json: unknown;
  _headers: Record<string, string>;
  _ended: boolean;
};

export function createMockRes(): MockRes {
  const res = {
    _status: 200,
    _json: undefined as unknown,
    _headers: {} as Record<string, string>,
    _ended: false,

    status(code: number) {
      res._status = code;

      return res;
    },

    json(data: unknown) {
      res._json = data;
      res._ended = true;

      return res;
    },

    end() {
      res._ended = true;

      return res;
    },

    setHeader(name: string, value: string) {
      res._headers[name.toLowerCase()] = value;

      return res;
    },

    getHeader(name: string) {
      return res._headers[name.toLowerCase()];
    },
  };

  return res as unknown as MockRes;
}

/** `errorMessage` from a handler's JSON body, or undefined. */
export function errorMessageOf(res: MockRes): string | undefined {
  const body = res._json;

  if (body && typeof body === "object" && "errorMessage" in body) {
    const message = (body as { errorMessage: unknown }).errorMessage;

    return typeof message === "string" ? message : undefined;
  }

  return undefined;
}
