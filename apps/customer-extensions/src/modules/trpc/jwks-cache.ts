import * as jose from "jose";

/**
 * Cache RemoteJWKSet instances per JWKS URL to avoid fetching keys on every request.
 *
 * jose caches keys internally within a RemoteJWKSet instance, but creating a new
 * instance per request defeats that caching and causes intermittent failures when
 * the JWKS endpoint is slow or temporarily unreachable.
 */
const jwksCache = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

export function getJWKS(jwksUrl: string): ReturnType<typeof jose.createRemoteJWKSet> {
  let jwks = jwksCache.get(jwksUrl);

  if (!jwks) {
    jwks = jose.createRemoteJWKSet(new URL(jwksUrl), {
      cooldownDuration: 30_000, // Wait 30s before refetching after a successful fetch
      timeoutDuration: 10_000, // 10s timeout for JWKS fetch (default is 5s)
    });
    jwksCache.set(jwksUrl, jwks);
  }

  return jwks;
}
