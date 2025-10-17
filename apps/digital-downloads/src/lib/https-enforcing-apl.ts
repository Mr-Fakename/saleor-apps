import { APL, AuthData } from "@saleor/app-sdk/APL";
import { createLogger } from "./logger";

const logger = createLogger("HttpsEnforcingAPL");

/**
 * APL wrapper that enforces HTTPS URLs in auth data
 * This ensures webhook handlers always receive HTTPS URLs for saleorApiUrl
 */
export class HttpsEnforcingAPL implements APL {
  private readonly baseApl: APL;

  constructor(baseApl: APL) {
    this.baseApl = baseApl;
  }

  private enforceHttps(authData: AuthData): AuthData {
    return {
      ...authData,
      saleorApiUrl: authData.saleorApiUrl.replace(/^http:\/\//, "https://"),
    };
  }

  async get(saleorApiUrl: string): Promise<AuthData | undefined> {
    logger.debug("APL get() called", {
      originalUrl: saleorApiUrl,
      isHttp: saleorApiUrl.startsWith("http://"),
      isHttps: saleorApiUrl.startsWith("https://"),
    });

    // Try multiple URL variants to handle HTTP/HTTPS inconsistencies
    const httpsUrl = saleorApiUrl.replace(/^http:\/\//, "https://");
    const httpUrl = saleorApiUrl.replace(/^https:\/\//, "http://");

    logger.debug("APL trying HTTPS URL first", { httpsUrl });

    // Try HTTPS first
    let authData = await this.baseApl.get(httpsUrl);

    if (!authData) {
      logger.debug("APL HTTPS lookup failed, trying HTTP", { httpUrl });
      authData = await this.baseApl.get(httpUrl);
    }

    // Fallback: Try original URL as-is
    if (!authData) {
      logger.debug("APL HTTP lookup failed, trying original URL", { saleorApiUrl });
      authData = await this.baseApl.get(saleorApiUrl);
    }

    const result = authData ? this.enforceHttps(authData) : undefined;

    if (!result) {
      logger.warn("APL authentication data not found after all attempts", {
        requestedUrl: saleorApiUrl,
        triedUrls: [httpsUrl, httpUrl, saleorApiUrl],
      });
    } else {
      logger.debug("APL authentication data found and normalized", {
        originalRequestUrl: saleorApiUrl,
        normalizedSaleorApiUrl: result.saleorApiUrl,
        wasConverted: result.saleorApiUrl !== saleorApiUrl,
        appId: result.appId,
      });
    }

    return result;
  }

  async set(authData: AuthData): Promise<void> {
    const enforcedData = this.enforceHttps(authData);

    logger.debug("APL set() called", {
      originalSaleorApiUrl: authData.saleorApiUrl,
      enforcedSaleorApiUrl: enforcedData.saleorApiUrl,
      wasConverted: authData.saleorApiUrl !== enforcedData.saleorApiUrl,
      appId: enforcedData.appId,
    });

    return this.baseApl.set(enforcedData);
  }

  async delete(saleorApiUrl: string): Promise<void> {
    // Try deleting both variants
    const httpsUrl = saleorApiUrl.replace(/^http:\/\//, "https://");

    await Promise.allSettled([this.baseApl.delete(httpsUrl), this.baseApl.delete(saleorApiUrl)]);
  }

  async getAll(): Promise<AuthData[]> {
    const allAuthData = await this.baseApl.getAll();
    return allAuthData.map((authData) => this.enforceHttps(authData));
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
