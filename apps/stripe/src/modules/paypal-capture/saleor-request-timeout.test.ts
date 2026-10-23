// @vitest-environment node
import { createGraphQLClient } from "@saleor/apps-shared/create-graphql-client";
import { describe, expect, it, vi } from "vitest";

import { SaleorCaptureGateway, SaleorCaptureGatewayTimeoutError } from "./saleor-capture-gateway";
import { createTimeoutFetch, isRequestTimeout, SALEOR_REQUEST_TIMEOUT_MS } from "./saleor-request-timeout";

/*
 * Item 5 of the review of d462375c: the capture worker's Saleor calls get a 15 s timeout. urql
 * replaces any per-operation `fetchOptions.signal` with its own (urql core 4.0.10,
 * makeFetchSource) but calls `operation.context.fetch` when given (fetchOperation), so the
 * timeout is a fetch wrapper that combines urql's signal with AbortSignal.timeout.
 */

/** A fetch that answers only when aborted, as a hung Saleor would. */
const hangingFetch = vi.fn(
  (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }),
);

describe("createTimeoutFetch", () => {
  it("defaults to 15 s", () => {
    expect(SALEOR_REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a call that takes longer than the timeout with a TimeoutError", async () => {
    const timedFetch = createTimeoutFetch(20, hangingFetch);

    const error = await timedFetch("https://saleor.test/graphql/", {
      signal: new AbortController().signal,
    }).catch((e: unknown) => e);

    expect(isRequestTimeout(error)).toBe(true);
  });

  it("still aborts when urql aborts first (operation teardown)", async () => {
    const urqlAbort = new AbortController();
    const timedFetch = createTimeoutFetch(60_000, hangingFetch);
    const pending = timedFetch("https://saleor.test/graphql/", { signal: urqlAbort.signal });

    urqlAbort.abort(new Error("teardown"));

    await expect(pending).rejects.toThrow("teardown");
  });

  it("passes a fast answer and the other options through", async () => {
    const answer = new Response("{}");
    const fastFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => answer);
    const timedFetch = createTimeoutFetch(60_000, fastFetch);

    await expect(
      timedFetch("https://saleor.test/graphql/", { method: "POST", headers: { a: "b" }, body: "q" }),
    ).resolves.toBe(answer);
    expect(fastFetch.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { a: "b" }, body: "q" });
    expect(fastFetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("with the real urql client (createGraphQLClient, auth exchange)", () => {
  it("times a hung Saleor call out, keeps the app token header, and reports an unknown outcome", async () => {
    const hung = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const gateway = new SaleorCaptureGateway(
      createGraphQLClient({ saleorApiUrl: "https://saleor.test/graphql/", token: "<app-token>" }),
      { timeoutMs: 50, fetch: hung },
    );

    const result = await gateway.requestCharge({ transactionId: "VHJhbnNhY3Rpb25JdGVtOjE=", amount: 101.5 });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(SaleorCaptureGatewayTimeoutError);
    expect(hung).toHaveBeenCalledOnce();
    expect(hung.mock.calls[0][1]?.headers).toMatchObject({ "authorization-bearer": "<app-token>" });
  });
});

describe("isRequestTimeout", () => {
  it.each([
    { error: Object.assign(new Error("x"), { name: "TimeoutError" }), expected: true },
    { error: new Error("ECONNREFUSED"), expected: false },
    { error: undefined, expected: false },
  ])("$error -> $expected", ({ error, expected }) => {
    expect(isRequestTimeout(error)).toBe(expected);
  });
});
