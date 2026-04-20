import { ViesValidationResult } from "./vies-types";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  result: ViesValidationResult;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function getCacheKey(countryCode: string, vatNumber: string): string {
  return `${countryCode}:${vatNumber}`.toUpperCase();
}

export function getCachedResult(
  countryCode: string,
  vatNumber: string,
): ViesValidationResult | null {
  const key = getCacheKey(countryCode, vatNumber);
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return { ...entry.result, cached: true };
}

export function setCachedResult(
  countryCode: string,
  vatNumber: string,
  result: ViesValidationResult,
): void {
  const key = getCacheKey(countryCode, vatNumber);
  cache.set(key, {
    result: { ...result, cached: false },
    timestamp: Date.now(),
  });
}

export function clearCache(): void {
  cache.clear();
}

// For testing
export const _internal = { CACHE_TTL_MS, cache };
