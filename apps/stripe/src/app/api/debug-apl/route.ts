import { NextRequest } from "next/server";
import { saleorApp } from "@/lib/saleor-app";
import { createLogger } from "@/lib/logger";

const logger = createLogger("debug-apl");

export async function GET(req: NextRequest) {
  try {
    logger.info("=== DEBUG APL: Fetching all auth data ===");

    const allAuthData = await saleorApp.apl.getAll();

    const debugInfo = {
      timestamp: new Date().toISOString(),
      authDataCount: allAuthData.length,
      authData: allAuthData.map((data) => ({
        appId: data.appId,
        saleorApiUrl: data.saleorApiUrl,
        token: data.token ? "present" : "missing",
      })),
      requestUrl: req.url,
      headers: {
        "saleor-api-url": req.headers.get("saleor-api-url"),
        "saleor-event": req.headers.get("saleor-event"),
      },
    };

    logger.info("=== DEBUG APL: Auth data retrieved ===", debugInfo);

    return Response.json(debugInfo, { status: 200 });
  } catch (error) {
    logger.error("=== DEBUG APL: Error ===", {
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
