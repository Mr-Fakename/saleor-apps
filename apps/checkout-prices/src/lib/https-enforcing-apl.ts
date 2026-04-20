import { APL, AuthData } from "@saleor/app-sdk/APL";

/**
 * APL wrapper that enforces HTTPS URLs in auth data
 * This ensures webhook handlers and API calls always receive HTTPS URLs for saleorApiUrl
 *
 * Problem: Saleor might register the app with HTTP URLs, but we need to enforce HTTPS
 * Solution: This wrapper automatically converts HTTP to HTTPS when storing/retrieving auth data
 */
export class HttpsEnforcingAPL implements APL {
  private readonly baseApl: APL;

  constructor(baseApl: APL) {
    this.baseApl = baseApl;
    console.log("[HttpsEnforcingAPL] Initialized - will enforce HTTPS on all Saleor API URLs");
  }

  private enforceHttps(authData: AuthData): AuthData {
    const originalUrl = authData.saleorApiUrl;
    const enforcedUrl = originalUrl.replace(/^http:\/\//, "https://");

    if (originalUrl !== enforcedUrl) {
      console.log("[HttpsEnforcingAPL] Converting HTTP to HTTPS:", {
        original: originalUrl,
        enforced: enforcedUrl,
      });
    }

    return {
      ...authData,
      saleorApiUrl: enforcedUrl,
    };
  }

  async get(saleorApiUrl: string): Promise<AuthData | undefined> {
    console.log("[HttpsEnforcingAPL] get() called", {
      originalUrl: saleorApiUrl,
      protocol: saleorApiUrl.startsWith("https://") ? "HTTPS" : "HTTP",
    });

    // Try multiple URL variants to handle HTTP/HTTPS inconsistencies
    const httpsUrl = saleorApiUrl.replace(/^http:\/\//, "https://");
    const httpUrl = saleorApiUrl.replace(/^https:\/\//, "http://");

    console.log("[HttpsEnforcingAPL] Trying HTTPS URL first:", httpsUrl);

    // Try HTTPS first (most common case)
    let authData = await this.baseApl.get(httpsUrl);

    if (!authData) {
      console.log("[HttpsEnforcingAPL] HTTPS lookup failed, trying HTTP:", httpUrl);
      authData = await this.baseApl.get(httpUrl);
    }

    // Fallback: Check if the URL is an internal Docker URL and try to match it with the public URL
    // This is useful if the app was registered with a public URL but is being called using an internal one
    if (!authData) {
      const isInternal = saleorApiUrl.includes("api:8000") || saleorApiUrl.includes("localhost:8000");
      if (isInternal) {
        console.log("[HttpsEnforcingAPL] URL looks internal, trying to find any registered auth data as fallback");
        const allAuth = await this.baseApl.getAll();
        if (allAuth.length === 1) {
          console.log("[HttpsEnforcingAPL] Found exactly one auth data entry, using it as fallback:", allAuth[0].saleorApiUrl);
          authData = allAuth[0];
        } else if (allAuth.length > 1) {
          console.log("[HttpsEnforcingAPL] Found multiple auth data entries, cannot pick a definitive fallback");
        }
      }
    }

    // Fallback: Try original URL as-is
    if (!authData && saleorApiUrl !== httpsUrl && saleorApiUrl !== httpUrl) {
      console.log("[HttpsEnforcingAPL] Both failed, trying original URL:", saleorApiUrl);
      authData = await this.baseApl.get(saleorApiUrl);
    }

    const result = authData ? this.enforceHttps(authData) : undefined;

    if (!result) {
      console.warn("[HttpsEnforcingAPL] ✗ Auth data not found after all attempts", {
        requestedUrl: saleorApiUrl,
        triedUrls: [httpsUrl, httpUrl, saleorApiUrl].filter((url, i, arr) => arr.indexOf(url) === i),
      });
    } else {
      console.log("[HttpsEnforcingAPL] ✓ Auth data found and normalized", {
        requestedUrl: saleorApiUrl,
        normalizedUrl: result.saleorApiUrl,
        wasConverted: result.saleorApiUrl !== saleorApiUrl,
        appId: result.appId,
      });
    }

    return result;
  }

  async set(authData: AuthData): Promise<void> {
    const enforcedData = this.enforceHttps(authData);

    console.log("[HttpsEnforcingAPL] set() called", {
      originalUrl: authData.saleorApiUrl,
      enforcedUrl: enforcedData.saleorApiUrl,
      wasConverted: authData.saleorApiUrl !== enforcedData.saleorApiUrl,
      appId: enforcedData.appId,
    });

    return this.baseApl.set(enforcedData);
  }

  async delete(saleorApiUrl: string): Promise<void> {
    console.log("[HttpsEnforcingAPL] delete() called:", saleorApiUrl);

    // Try deleting both HTTP and HTTPS variants to be safe
    const httpsUrl = saleorApiUrl.replace(/^http:\/\//, "https://");
    const httpUrl = saleorApiUrl.replace(/^https:\/\//, "http://");

    const deletePromises = [
      this.baseApl.delete(httpsUrl),
      ...(httpUrl !== httpsUrl ? [this.baseApl.delete(httpUrl)] : []),
    ];

    await Promise.allSettled(deletePromises);
    console.log("[HttpsEnforcingAPL] ✓ Deleted auth data for both HTTP and HTTPS variants");
  }

  async getAll(): Promise<AuthData[]> {
    console.log("[HttpsEnforcingAPL] getAll() called");
    const allAuthData = await this.baseApl.getAll();
    const enforcedData = allAuthData.map((authData) => this.enforceHttps(authData));

    console.log(`[HttpsEnforcingAPL] Returning ${enforcedData.length} auth data entries`);
    return enforcedData;
  }

  async isReady() {
    if (this.baseApl.isReady) {
      return this.baseApl.isReady();
    }

    return { ready: true } as const;
  }

  async isConfigured() {
    if (this.baseApl.isConfigured) {
      return this.baseApl.isConfigured();
    }

    return { configured: true } as const;
  }
}
