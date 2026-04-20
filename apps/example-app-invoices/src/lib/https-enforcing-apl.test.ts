import { HttpsEnforcingAPL } from "./https-enforcing-apl";
import { APL, AuthData } from "@saleor/app-sdk/APL";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock logger to avoid dependencies in tests
vi.mock("../logger", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("HttpsEnforcingAPL", () => {
  let mockBaseApl: ReturnType<typeof vi.mocked<APL>>;
  let httpsApl: HttpsEnforcingAPL;

  const sampleAuthData: AuthData = {
    appId: "test-app",
    saleorApiUrl: "http://example.com/graphql/",
    token: "test-token",
    jwks: "test-jwks",
  };

  beforeEach(() => {
    mockBaseApl = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      getAll: vi.fn(),
      isReady: vi.fn(),
      isConfigured: vi.fn(),
    };

    httpsApl = new HttpsEnforcingAPL(mockBaseApl);
  });

  describe("get", () => {
    it("should try HTTPS URL first", async () => {
      mockBaseApl.get.mockResolvedValueOnce(sampleAuthData);

      const result = await httpsApl.get("http://example.com/graphql/");

      expect(mockBaseApl.get).toHaveBeenCalledWith("https://example.com/graphql/");
      expect(result?.saleorApiUrl).toBe("https://example.com/graphql/");
    });

    it("should fallback to HTTP URL if HTTPS fails", async () => {
      mockBaseApl.get
        .mockResolvedValueOnce(undefined) // HTTPS fails
        .mockResolvedValueOnce(sampleAuthData); // HTTP succeeds

      const result = await httpsApl.get("http://example.com/graphql/");

      expect(mockBaseApl.get).toHaveBeenCalledWith("https://example.com/graphql/");
      expect(mockBaseApl.get).toHaveBeenCalledWith("http://example.com/graphql/");
      expect(result?.saleorApiUrl).toBe("https://example.com/graphql/");
    });

    it("should fallback to original URL if both HTTPS and HTTP fail", async () => {
      mockBaseApl.get
        .mockResolvedValueOnce(undefined) // HTTPS fails
        .mockResolvedValueOnce(undefined) // HTTP fails
        .mockResolvedValueOnce(sampleAuthData); // Original succeeds

      const result = await httpsApl.get("http://example.com/graphql/");

      expect(mockBaseApl.get).toHaveBeenCalledTimes(3);
      expect(result?.saleorApiUrl).toBe("https://example.com/graphql/");
    });

    it("should return undefined if no auth data found", async () => {
      mockBaseApl.get.mockResolvedValue(undefined);

      const result = await httpsApl.get("http://example.com/graphql/");

      expect(result).toBeUndefined();
    });
  });

  describe("set", () => {
    it("should enforce HTTPS before storing", async () => {
      await httpsApl.set(sampleAuthData);

      expect(mockBaseApl.set).toHaveBeenCalledWith({
        ...sampleAuthData,
        saleorApiUrl: "https://example.com/graphql/",
      });
    });
  });

  describe("delete", () => {
    it("should try deleting both HTTP and HTTPS variants", async () => {
      await httpsApl.delete("http://example.com/graphql/");

      expect(mockBaseApl.delete).toHaveBeenCalledWith("https://example.com/graphql/");
      expect(mockBaseApl.delete).toHaveBeenCalledWith("http://example.com/graphql/");
    });
  });

  describe("getAll", () => {
    it("should enforce HTTPS on all returned auth data", async () => {
      const authDataArray = [
        sampleAuthData,
        { ...sampleAuthData, saleorApiUrl: "https://example2.com/graphql/" },
      ];

      mockBaseApl.getAll.mockResolvedValueOnce(authDataArray);

      const result = await httpsApl.getAll();

      expect(result).toHaveLength(2);
      expect(result[0].saleorApiUrl).toBe("https://example.com/graphql/");
      expect(result[1].saleorApiUrl).toBe("https://example2.com/graphql/");
    });
  });
});