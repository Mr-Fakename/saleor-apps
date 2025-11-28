import { NextRequest, NextResponse } from "next/server";

import { downloadTokenRepoImpl } from "@/modules/download-tokens/repositories/download-token-repo-impl";
import { createLogger } from "@/lib/logger";
import { env } from "@/lib/env";

const logger = createLogger("Order Downloads API");

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const { orderId } = await params;
    const searchParams = req.nextUrl.searchParams;
    const customerEmail = searchParams.get("email");

    logger.info("Order downloads request received", { orderId, customerEmail });

    // Validate required parameters
    if (!customerEmail) {
      logger.warn("Missing customer email", { orderId });
      return NextResponse.json({ error: "Customer email is required" }, { status: 400 });
    }

    // Fetch tokens for the order
    const tokensResult = await downloadTokenRepoImpl.listByOrder(orderId);

    if (tokensResult.isErr()) {
      logger.error("Failed to fetch download tokens", {
        orderId,
        error: tokensResult.error.message,
      });

      return NextResponse.json(
        { error: "Failed to fetch download tokens" },
        { status: 500 },
      );
    }

    const tokens = tokensResult.value;

    // Filter tokens to only include those belonging to this customer
    // This provides security - users can only see their own download links
    const customerTokens = tokens.filter((token) => {
      return token.customerEmail?.toLowerCase() === customerEmail.toLowerCase();
    });

    if (customerTokens.length === 0) {
      logger.info("No download tokens found for customer", { orderId, customerEmail });
      return NextResponse.json({ downloads: [] });
    }

    // Format response with download information
    const downloads = customerTokens.map((token) => ({
      productName: token.productName,
      variantName: token.variantName,
      downloadUrl: `${env.APP_API_BASE_URL}/api/downloads/${token.token}`,
      expiresAt: token.expiresAt,
      maxDownloads: token.maxDownloads,
      downloadCount: token.downloadCount,
      createdAt: token.createdAt,
    }));

    logger.info("Download tokens retrieved successfully", {
      orderId,
      customerEmail,
      count: downloads.length,
    });

    return NextResponse.json({ downloads });
  } catch (error) {
    logger.error("Unhandled error in order downloads route", { error });

    return NextResponse.json(
      {
        error: "Internal server error",
      },
      { status: 500 },
    );
  }
}
