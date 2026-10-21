export type OriginDecision =
  | {
      allowed: true;
      /** CORS headers to attach to the response; empty for non-browser callers. */
      corsHeaders: Record<string, string>;
    }
  | {
      allowed: false;
      origin: string;
    };

const normalizeOrigin = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
};

/**
 * Browser-origin policy for `/api/update-payment-intent`.
 *
 * The storefronts call this route server-to-server through their own proxy
 * (`/api/stripe/update-payment-intent`), and server-side `fetch` sends no `Origin`
 * header, so those calls are always allowed. Browsers always send `Origin` on POST
 * (same-origin included), so any request that carries one must come from an origin in
 * the allowlist (`UPDATE_PAYMENT_INTENT_ALLOWED_ORIGINS`, comma-separated). Unset or
 * empty allowlist = no browser origin is accepted. `*` and opaque (`null`) origins are
 * never accepted.
 */
export class RequestOriginPolicy {
  private readonly allowedOrigins: ReadonlySet<string>;

  private constructor(allowedOrigins: ReadonlySet<string>) {
    this.allowedOrigins = allowedOrigins;
  }

  static fromAllowList(rawAllowList: string | undefined): RequestOriginPolicy {
    const origins = (rawAllowList ?? "")
      .split(",")
      .map((entry) => normalizeOrigin(entry))
      .filter((origin): origin is string => origin !== null);

    return new RequestOriginPolicy(new Set(origins));
  }

  evaluate(originHeader: string | null): OriginDecision {
    if (originHeader === null || originHeader.trim() === "") {
      return { allowed: true, corsHeaders: {} };
    }

    const origin = normalizeOrigin(originHeader);

    if (origin === null || !this.allowedOrigins.has(origin)) {
      return { allowed: false, origin: originHeader };
    }

    return {
      allowed: true,
      corsHeaders: {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
      },
    };
  }
}
