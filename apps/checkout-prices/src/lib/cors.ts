import type { NextApiRequest, NextApiResponse } from "next";

/**
 * CORS / Origin policy for the app's public API routes.
 *
 * Browsers attach an `Origin` header to cross-origin requests (and to
 * same-origin non-GET fetches); server-to-server callers (the storefront's
 * server actions and route handlers) send none. The policy is therefore:
 *
 *  - no Origin            -> server-to-server call: proceed, no CORS headers
 *                            (a bare OPTIONS probe gets 204 — .ops/pipeline/verify.sh
 *                            checks that /api/payment-fee answers OPTIONS)
 *  - Origin in allowlist  -> proceed and echo that origin
 *                            (the storefront calls /api/payment-fee from the browser)
 *  - Origin on our host   -> the app's own pages (e.g. /storefront demo): proceed
 *  - any other Origin     -> 403, never reaches Saleor
 *
 * The allowlist is ALLOWED_ORIGINS: comma-separated bare origins, e.g.
 * "https://dess-equipement.com,https://www.dess-equipement.com". Unset or
 * empty = deny every cross-origin browser call. "*" is not supported.
 *
 * This is a browser-side control only: non-browser clients can send any
 * Origin, so it complements — never replaces — server-side validation.
 */

const ALLOWED_HEADERS = "Content-Type";
const PREFLIGHT_MAX_AGE_SECONDS = "86400";

type CorsErrorBody = { errorMessage: string };

let cachedAllowlist: { raw: string; origins: ReadonlySet<string> } | null = null;

/** A bare http(s) origin (no path/query/credentials), normalized; else null. */
function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function parseAllowedOrigins(raw: string | undefined): ReadonlySet<string> {
  const origins = new Set<string>();

  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();

    if (!trimmed) {
      continue;
    }
    const origin = normalizeOrigin(trimmed);

    if (origin) {
      origins.add(origin);
    } else {
      console.warn(`[CORS] Ignoring invalid ALLOWED_ORIGINS entry ${JSON.stringify(trimmed)}`);
    }
  }

  return origins;
}

function getAllowedOrigins(): ReadonlySet<string> {
  const raw = process.env.ALLOWED_ORIGINS ?? "";

  if (!cachedAllowlist || cachedAllowlist.raw !== raw) {
    cachedAllowlist = { raw, origins: parseAllowedOrigins(raw) };
  }

  return cachedAllowlist.origins;
}

function isOwnHost(req: NextApiRequest, origin: string): boolean {
  const host = req.headers.host;

  if (!host) {
    return false;
  }
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Applies the policy above. Returns true when the request has been fully
 * answered (preflight or rejection) and the handler must return immediately.
 */
export function handleCors(
  req: NextApiRequest,
  res: NextApiResponse<CorsErrorBody>,
  { methods }: { methods: readonly string[] },
): boolean {
  res.setHeader("Vary", "Origin");

  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;

  if (origin === undefined) {
    if (req.method === "OPTIONS") {
      res.status(204).end();

      return true;
    }

    return false;
  }

  const normalized = normalizeOrigin(origin);
  const allowed = normalized !== null && getAllowedOrigins().has(normalized);

  if (!allowed && !isOwnHost(req, origin)) {
    console.warn(`[CORS] Rejected ${req.method ?? "?"} from disallowed origin ${JSON.stringify(origin.slice(0, 200))}`);

    if (req.method === "OPTIONS") {
      res.status(403).end();
    } else {
      res.status(403).json({ errorMessage: "Origin not allowed" });
    }

    return true;
  }

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    res.setHeader("Access-Control-Max-Age", PREFLIGHT_MAX_AGE_SECONDS);
  }

  if (req.method === "OPTIONS") {
    res.status(204).end();

    return true;
  }

  return false;
}
