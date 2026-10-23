/**
 * A3d (review of d462375c, item 5): every Saleor call of the capture worker ends within this
 * time, so one check stays well inside its 60 s claim lock (CAPTURE_CLAIM_LOCK_MS).
 */
export const SALEOR_REQUEST_TIMEOUT_MS = 15_000;

/**
 * A fetch for urql's operation context (`context.fetch`) that gives up after `timeoutMs`.
 *
 * urql core 4.0.10 replaces any per-operation `fetchOptions.signal` with the signal of its own
 * AbortController (makeFetchSource, aborted when the operation is torn down) and calls
 * `operation.context.fetch` when one is given (fetchOperation). So the timeout is applied here,
 * on top of urql's signal: either one aborts the request. A timeout rejects with a DOMException
 * named "TimeoutError", which urql returns as the result's networkError.
 */
export const createTimeoutFetch =
  (timeoutMs: number = SALEOR_REQUEST_TIMEOUT_MS, baseFetch?: typeof fetch): typeof fetch =>
  (input, init) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;

    // The global fetch at call time, as urql uses it (instrumentation may wrap it after boot).
    return (baseFetch ?? globalThis.fetch)(input, { ...init, signal });
  };

/** True for the error createTimeoutFetch rejects with when the time is up. */
export const isRequestTimeout = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { name?: unknown }).name === "TimeoutError";
