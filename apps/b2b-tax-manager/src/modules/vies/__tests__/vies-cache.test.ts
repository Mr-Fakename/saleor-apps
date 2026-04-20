import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getCachedResult,
  setCachedResult,
  clearCache,
  _internal,
} from "../vies-cache";
import { ViesValidationResult } from "../vies-types";

describe("ViesCache", () => {
  const mockResult: ViesValidationResult = {
    valid: true,
    companyName: "Test GmbH",
    companyAddress: "Berlin",
    requestDate: "2026-03-17",
    cached: false,
    error: null,
  };

  beforeEach(() => {
    clearCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for cache miss", () => {
    expect(getCachedResult("DE", "123456789")).toBeNull();
  });

  it("stores and retrieves cached result", () => {
    setCachedResult("DE", "123456789", mockResult);
    const cached = getCachedResult("DE", "123456789");

    expect(cached).not.toBeNull();
    expect(cached!.valid).toBe(true);
    expect(cached!.cached).toBe(true);
    expect(cached!.companyName).toBe("Test GmbH");
  });

  it("is case-insensitive for keys", () => {
    setCachedResult("de", "123456789", mockResult);
    const cached = getCachedResult("DE", "123456789");

    expect(cached).not.toBeNull();
  });

  it("expires entries after 24 hours", () => {
    setCachedResult("DE", "123456789", mockResult);

    // Advance time by 24h + 1ms
    vi.advanceTimersByTime(_internal.CACHE_TTL_MS + 1);

    expect(getCachedResult("DE", "123456789")).toBeNull();
  });

  it("returns valid entries within 24 hours", () => {
    setCachedResult("DE", "123456789", mockResult);

    // Advance by 23h 59m
    vi.advanceTimersByTime(_internal.CACHE_TTL_MS - 60000);

    expect(getCachedResult("DE", "123456789")).not.toBeNull();
  });

  it("clearCache removes all entries", () => {
    setCachedResult("DE", "111111111", mockResult);
    setCachedResult("FR", "222222222", mockResult);
    clearCache();

    expect(getCachedResult("DE", "111111111")).toBeNull();
    expect(getCachedResult("FR", "222222222")).toBeNull();
  });
});
