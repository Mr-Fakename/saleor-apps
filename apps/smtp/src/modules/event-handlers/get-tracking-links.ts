const LA_POSTE_TRACKING_URL = "https://www.laposte.fr/outils/suivre-vos-envois";

export interface TrackingLink {
  code: string;
  url: string;
}

interface FulfillmentLike {
  trackingNumber?: string | null;
}

/**
 * Normalizes fulfillment tracking numbers into { code, url } pairs for email
 * templates. Staff sometimes paste the full carrier URL into the Dashboard
 * tracking field, sometimes just the bare code. All shipments go through
 * La Poste, so bare codes link to the La Poste tracker.
 *
 * Mirrors the storefront's src/lib/tracking.ts — keep the two in sync.
 */
export function getTrackingLinks(
  fulfillments: Array<FulfillmentLike> | null | undefined,
): TrackingLink[] {
  if (!fulfillments) {
    return [];
  }

  const links: TrackingLink[] = [];

  for (const fulfillment of fulfillments) {
    const trimmed = fulfillment.trackingNumber?.trim();

    if (!trimmed) {
      continue;
    }

    if (/^https?:\/\//i.test(trimmed)) {
      let code = trimmed;

      try {
        code = new URL(trimmed).searchParams.get("code") || trimmed;
      } catch {
        // Malformed URL — fall back to displaying the raw value
      }
      links.push({ code, url: trimmed });
    } else {
      links.push({
        code: trimmed,
        url: `${LA_POSTE_TRACKING_URL}?code=${encodeURIComponent(trimmed)}`,
      });
    }
  }

  return links;
}
