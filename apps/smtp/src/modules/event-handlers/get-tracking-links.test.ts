import { describe, expect, it } from "vitest";

import { getTrackingLinks } from "./get-tracking-links";

describe("getTrackingLinks", () => {
  it("extracts the code from a pasted carrier URL and links to it as-is", () => {
    const result = getTrackingLinks([
      { trackingNumber: "https://www.laposte.fr/outils/suivre-vos-envois?code=AB123456789" },
    ]);

    expect(result).toEqual([
      {
        code: "AB123456789",
        url: "https://www.laposte.fr/outils/suivre-vos-envois?code=AB123456789",
      },
    ]);
  });

  it("keeps the full URL as display code when it has no ?code= param", () => {
    const url = "https://www.laposte.fr/outils/suivre-vos-envois";
    const result = getTrackingLinks([{ trackingNumber: url }]);

    expect(result).toEqual([{ code: url, url }]);
  });

  it("builds a La Poste tracker URL from a bare code", () => {
    const result = getTrackingLinks([{ trackingNumber: "AB123456789" }]);

    expect(result).toEqual([
      {
        code: "AB123456789",
        url: "https://www.laposte.fr/outils/suivre-vos-envois?code=AB123456789",
      },
    ]);
  });

  it("URL-encodes bare codes", () => {
    const result = getTrackingLinks([{ trackingNumber: "AB 12/34" }]);

    expect(result[0].url).toBe(
      "https://www.laposte.fr/outils/suivre-vos-envois?code=AB%2012%2F34",
    );
  });

  it("skips fulfillments with empty or missing tracking numbers", () => {
    const result = getTrackingLinks([
      { trackingNumber: "" },
      { trackingNumber: "   " },
      { trackingNumber: null },
      { trackingNumber: undefined },
      { trackingNumber: "AB123456789" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].code).toBe("AB123456789");
  });

  it("returns an empty array for null/undefined fulfillments", () => {
    expect(getTrackingLinks(null)).toEqual([]);
    expect(getTrackingLinks(undefined)).toEqual([]);
  });
});
