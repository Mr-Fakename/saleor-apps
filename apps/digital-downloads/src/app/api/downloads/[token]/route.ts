import { NextRequest, NextResponse } from "next/server";
import { captureException } from "@sentry/nextjs";

import { downloadTokenRepoImpl } from "@/modules/download-tokens/repositories/download-token-repo-impl";
import { verifyDownloadToken } from "@/modules/token-generator/verify-download-token";
import { createLogger } from "@/lib/logger";

const logger = createLogger("Downloads API");

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token: tokenParam } = await params;

    logger.info("Download request received", { token: tokenParam });

    // Verify token signature
    const verificationResult = verifyDownloadToken(tokenParam);

    if (verificationResult.isErr()) {
      logger.warn("Invalid token signature", {
        token: tokenParam,
        error: verificationResult.error.message,
      });

      return NextResponse.json({ error: "Invalid or malformed token" }, { status: 401 });
    }

    // Fetch token from DB
    const tokenResult = await downloadTokenRepoImpl.getByToken(tokenParam);

    if (tokenResult.isErr()) {
      logger.warn("Token not found in database", {
        token: tokenParam,
        error: tokenResult.error.message,
      });

      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }

    const token = tokenResult.value;

    // Check expiry
    const now = new Date();
    const expiryDate = new Date(token.expiresAt);

    if (expiryDate < now) {
      logger.warn("Token has expired", {
        token: tokenParam,
        expiresAt: token.expiresAt,
        now: now.toISOString(),
      });

      return NextResponse.json(
        {
          error: "Token has expired",
          expiresAt: token.expiresAt,
        },
        { status: 410 },
      );
    }

    // Check download limits
    if (token.downloadCount >= token.maxDownloads) {
      logger.warn("Download limit exceeded", {
        token: tokenParam,
        downloadCount: token.downloadCount,
        maxDownloads: token.maxDownloads,
      });

      return NextResponse.json(
        {
          error: "Download limit exceeded",
          downloadCount: token.downloadCount,
          maxDownloads: token.maxDownloads,
        },
        { status: 403 },
      );
    }

    // Increment download count
    const incrementResult = await downloadTokenRepoImpl.incrementDownloadCount(tokenParam);

    if (incrementResult.isErr()) {
      logger.error("Failed to increment download count", {
        token: tokenParam,
        error: incrementResult.error.message,
      });

      // Continue with download even if increment fails
      captureException(incrementResult.error);
    }

    logger.info("Download authorized, fetching file", {
      token: tokenParam,
      fileUrl: token.fileUrl,
      downloadCount: token.downloadCount + 1,
      productName: token.productName,
    });

    // Fetch the file from Saleor and proxy it to the user
    // This ensures the file is accessible even if Saleor requires authentication
    try {
      const fileResponse = await fetch(token.fileUrl);

      if (!fileResponse.ok) {
        logger.error("Failed to fetch file from Saleor", {
          token: tokenParam,
          fileUrl: token.fileUrl,
          status: fileResponse.status,
          statusText: fileResponse.statusText,
        });

        return NextResponse.json(
          {
            error: "File not found or inaccessible",
            details: `Saleor returned ${fileResponse.status}: ${fileResponse.statusText}`,
          },
          { status: 502 },
        );
      }

      // Get the file as a blob
      const blob = await fileResponse.blob();
      const buffer = Buffer.from(await blob.arrayBuffer());

      // Extract filename from URL or use product name
      const urlParts = token.fileUrl.split("/");
      const filename =
        urlParts[urlParts.length - 1] || `${token.productName.replace(/[^a-z0-9]/gi, "_")}.file`;

      // Get content type from response or blob
      const contentType =
        fileResponse.headers.get("content-type") || blob.type || "application/octet-stream";

      logger.info("File fetched successfully, streaming to user", {
        token: tokenParam,
        filename,
        contentType,
        size: buffer.length,
      });

      // Return the file with appropriate headers
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": buffer.length.toString(),
        },
      });
    } catch (fetchError) {
      logger.error("Error fetching file from Saleor", {
        token: tokenParam,
        fileUrl: token.fileUrl,
        error: fetchError instanceof Error ? fetchError.message : String(fetchError),
      });

      captureException(fetchError);

      return NextResponse.json(
        {
          error: "Failed to retrieve file",
          details: fetchError instanceof Error ? fetchError.message : "Unknown error",
        },
        { status: 502 },
      );
    }
  } catch (error) {
    logger.error("Unhandled error in download route", { error });
    captureException(error);

    return NextResponse.json(
      {
        error: "Internal server error",
      },
      { status: 500 },
    );
  }
}
