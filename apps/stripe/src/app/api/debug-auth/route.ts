import { NextRequest } from "next/server";
import { saleorApp } from "@/lib/saleor-app";
import { createLogger } from "@/lib/logger";

const logger = createLogger("debug-auth");

export async function GET(req: NextRequest) {
  try {
    const testUrls = [
      "http://saleor-api.vps.daybreakdevelopment.eu/graphql/",
      "https://saleor-api.vps.daybreakdevelopment.eu/graphql/",
    ];

    const results = [];

    for (const url of testUrls) {
      logger.info(`=== DEBUG AUTH: Testing URL: ${url} ===`);

      const authData = await saleorApp.apl.get(url);

      const result = {
        testUrl: url,
        found: !!authData,
        appId: authData?.appId,
        saleorApiUrl: authData?.saleorApiUrl,
        token: authData?.token ? "present" : "missing",
      };

      results.push(result);
      logger.info(`=== DEBUG AUTH: Result for ${url} ===`, result);
    }

    const debugInfo = {
      timestamp: new Date().toISOString(),
      testResults: results,
      requestHeaders: {
        "saleor-api-url": req.headers.get("saleor-api-url"),
        "user-agent": req.headers.get("user-agent"),
      },
    };

    return Response.json(debugInfo, { status: 200 });
  } catch (error) {
    logger.error("=== DEBUG AUTH: Error ===", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
