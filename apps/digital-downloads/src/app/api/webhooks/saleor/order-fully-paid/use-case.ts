import { err, ok, Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { env } from "@/lib/env";
import {
  createDownloadToken,
  DownloadToken,
} from "@/modules/download-tokens/domain/download-token";
import { downloadTokenRepoImpl } from "@/modules/download-tokens/repositories/download-token-repo-impl";
import type { DownloadTokenRepo } from "@/modules/download-tokens/repositories/download-token-repo";
import { generateDownloadToken } from "@/modules/token-generator/generate-download-token";
import { OrderFullyPaidEventFragment } from "@/app/api/webhooks/saleor/order-fully-paid/webhook-definition";
import { emailSender } from "@/modules/email/email-sender";
import { generateOrderConfirmationEmail } from "@/modules/email/order-confirmation-template";

const logger = createLogger("OrderFullyPaidUseCase");

export const OrderFullyPaidUseCaseErrors = {
  NoDigitalItemsError: BaseError.subclass("NoDigitalItemsError", {
    props: {
      _brand: "OrderFullyPaidUseCase.NoDigitalItemsError" as const,
    },
  }),
  TokenGenerationError: BaseError.subclass("TokenGenerationError", {
    props: {
      _brand: "OrderFullyPaidUseCase.TokenGenerationError" as const,
    },
  }),
};

export type OrderFullyPaidUseCaseError =
  | InstanceType<typeof OrderFullyPaidUseCaseErrors.NoDigitalItemsError>
  | InstanceType<typeof OrderFullyPaidUseCaseErrors.TokenGenerationError>;

export interface OrderFullyPaidUseCaseInput {
  payload: OrderFullyPaidEventFragment;
}

export interface OrderFullyPaidUseCaseOutput {
  tokensCreated: number;
  tokens: DownloadToken[];
}

/**
 * Checks if a product/variant is a digital product
 *
 * Priority order:
 * 1. Product Type's isDigital flag (most reliable)
 * 2. Product metadata with key "digital_download"
 * 3. Variant metadata with key "digital_download"
 *
 * This prevents regular products with images from being treated as digital products
 */
function hasDigitalFiles(line: any): boolean {
  const product = line?.variant?.product;

  // Check 1: Product Type isDigital flag
  if (product?.productType?.isDigital === true) {
    return true;
  }

  // Check 2: Product metadata
  const productMetadata = product?.metadata || [];
  const hasProductDigitalFlag = productMetadata.some(
    (meta: any) => meta.key === "digital_download" && meta.value === "true",
  );

  if (hasProductDigitalFlag) {
    return true;
  }

  // Check 3: Variant metadata
  const variantMetadata = line?.variant?.metadata || [];
  const hasVariantDigitalFlag = variantMetadata.some(
    (meta: any) => meta.key === "digital_download" && meta.value === "true",
  );

  return hasVariantDigitalFlag;
}

/**
 * Extracts the file URL from a line item
 * Priority: variant attributes with files > variant media > product media
 */
function getFileUrl(line: any): string | null {
  // Check 1: Variant attributes with file values (highest priority)
  const variantAttributes = line?.variant?.attributes || [];
  for (const attr of variantAttributes) {
    const values = attr?.values || [];
    for (const value of values) {
      if (value?.file?.url) {
        return value.file.url;
      }
    }
  }

  // Check 2: Variant media
  const variantMedia = line?.variant?.media || [];
  if (variantMedia.length > 0) {
    return variantMedia[0]?.url || null;
  }

  // Check 3: Product media (lowest priority)
  const productMedia = line?.variant?.product?.media || [];
  if (productMedia.length > 0) {
    return productMedia[0]?.url || null;
  }

  return null;
}

export class OrderFullyPaidUseCase {
  private downloadTokenRepo: DownloadTokenRepo;

  constructor({ downloadTokenRepo }: { downloadTokenRepo: DownloadTokenRepo }) {
    this.downloadTokenRepo = downloadTokenRepo;
  }

  async execute(
    input: OrderFullyPaidUseCaseInput,
  ): Promise<Result<OrderFullyPaidUseCaseOutput, OrderFullyPaidUseCaseError>> {
    try {
      const { payload } = input;
      const order = payload.order;

      if (!order || !order.lines) {
        logger.warn("Order or order lines not found in payload");
        return err(
          new OrderFullyPaidUseCaseErrors.NoDigitalItemsError("Order data is missing", {
            cause: { payload },
          }),
        );
      }

      logger.info(
        "🚀 NEW CODE RUNNING - Processing ORDER_FULLY_PAID webhook v2 with attributes support",
        {
          orderId: order.id,
          orderNumber: order.number,
          codeVersion: "2.0-with-attributes",
        },
      );

      // Debug: Log all order lines and their media
      order.lines.forEach((line, index) => {
        logger.debug("Order line details", {
          lineIndex: index,
          lineId: line.id,
          productName: line.productName,
          variantName: line.variantName,
          variantId: line.variant?.id,
          productId: line.variant?.product?.id,
          productTypeIsDigital: line.variant?.product?.productType?.isDigital,
          productTypeName: line.variant?.product?.productType?.name,
          productMetadata: line.variant?.product?.metadata,
          variantMetadata: line.variant?.metadata,
          variantAttributes: line.variant?.attributes,
          variantMediaCount: line.variant?.media?.length || 0,
          productMediaCount: line.variant?.product?.media?.length || 0,
          variantMedia: line.variant?.media,
          productMedia: line.variant?.product?.media,
        });
      });

      // Filter lines that have digital files
      const digitalLines = order.lines.filter((line) => hasDigitalFiles(line));

      if (digitalLines.length === 0) {
        logger.info("No digital items found in order", {
          orderId: order.id,
          orderNumber: order.number,
        });

        return err(
          new OrderFullyPaidUseCaseErrors.NoDigitalItemsError("No digital items found in order", {
            cause: { orderId: order.id },
          }),
        );
      }

      logger.debug("Found digital items in order", {
        orderId: order.id,
        count: digitalLines.length,
      });

      // Generate download tokens for each digital line
      const tokens: DownloadToken[] = [];
      const expiryDate = new Date();

      expiryDate.setHours(expiryDate.getHours() + env.DOWNLOAD_TOKEN_EXPIRY_HOURS);

      for (const line of digitalLines) {
        const fileUrl = getFileUrl(line);

        if (!fileUrl) {
          logger.warn("No file URL found for digital line", {
            orderId: order.id,
            lineId: line.id,
          });
          continue;
        }

        // Generate the token signature
        const tokenString = generateDownloadToken({
          orderId: order.id,
          fileUrl: fileUrl,
          expiresAt: expiryDate.toISOString(),
        });

        // Create the download token entity
        const downloadToken = createDownloadToken({
          token: tokenString as DownloadToken["token"],
          orderId: order.id,
          orderNumber: order.number,
          customerId: order.user?.id,
          customerEmail: order.user?.email || undefined,
          fileUrl: fileUrl,
          productName: line.productName,
          variantName: line.variantName || undefined,
          expiresAt: expiryDate.toISOString(),
          maxDownloads: env.MAX_DOWNLOAD_LIMIT,
        });

        // Save to repository
        const saveResult = await this.downloadTokenRepo.save(downloadToken);

        if (saveResult.isErr()) {
          logger.error("Failed to save download token", {
            orderId: order.id,
            lineId: line.id,
            error: saveResult.error,
          });
          continue;
        }

        tokens.push(downloadToken);

        // Construct the download URL for testing
        const downloadUrl = `${env.APP_API_BASE_URL}/api/downloads/${tokenString}`;

        logger.info("Download token created successfully", {
          orderId: order.id,
          lineId: line.id,
          token: tokenString,
          downloadUrl: downloadUrl,
        });

        // Log download URL to console for easy testing
        console.log("\n╔═══════════════════════════════════════════════════════════════════");
        console.log("║ 🔗 DOWNLOAD LINK CREATED");
        console.log("╠═══════════════════════════════════════════════════════════════════");
        console.log(`║ Product: ${line.productName}`);
        if (line.variantName) {
          console.log(`║ Variant: ${line.variantName}`);
        }
        console.log(`║ Order: ${order.number}`);
        console.log(`║ Customer: ${order.user?.email || "Guest"}`);
        console.log("╠═══════════════════════════════════════════════════════════════════");
        console.log(`║ 📥 Download URL:`);
        console.log(`║ ${downloadUrl}`);
        console.log("╠═══════════════════════════════════════════════════════════════════");
        console.log(`║ Valid until: ${expiryDate.toISOString()}`);
        console.log(`║ Max downloads: ${env.MAX_DOWNLOAD_LIMIT}`);
        console.log("╚═══════════════════════════════════════════════════════════════════\n");
      }

      if (tokens.length === 0) {
        return err(
          new OrderFullyPaidUseCaseErrors.TokenGenerationError(
            "Failed to generate any download tokens",
            {
              cause: { orderId: order.id },
            },
          ),
        );
      }

      logger.info("Successfully processed order", {
        orderId: order.id,
        tokensCreated: tokens.length,
      });

      // Send order confirmation email with download links
      if (order.user?.email && env.EMAIL_ENABLED) {
        logger.info("Sending order confirmation email", {
          orderId: order.id,
          customerEmail: order.user.email,
          tokensCount: tokens.length,
        });

        const appBaseUrl = env.APP_API_BASE_URL || "http://localhost:3003";
        const emailTemplate = generateOrderConfirmationEmail({
          orderNumber: order.number,
          customerEmail: order.user.email,
          downloadTokens: tokens,
          appBaseUrl: appBaseUrl,
        });

        const emailResult = await emailSender.sendEmail({
          to: order.user.email,
          subject: emailTemplate.subject,
          html: emailTemplate.html,
          text: emailTemplate.text,
        });

        if (emailResult.isErr()) {
          logger.error("Failed to send order confirmation email", {
            orderId: order.id,
            customerEmail: order.user.email,
            error: emailResult.error,
          });
          // Don't fail the whole webhook - tokens were created successfully
          // Email failure is a non-critical error
        } else {
          logger.info("Order confirmation email sent successfully", {
            orderId: order.id,
            customerEmail: order.user.email,
          });
        }
      } else {
        if (!order.user?.email) {
          logger.warn("Cannot send email - no customer email found", {
            orderId: order.id,
          });
        } else if (!env.EMAIL_ENABLED) {
          logger.debug("Email sending disabled via EMAIL_ENABLED=false", {
            orderId: order.id,
          });
        }
      }

      return ok({
        tokensCreated: tokens.length,
        tokens,
      });
    } catch (error) {
      logger.error("Unhandled error in OrderFullyPaidUseCase", { error });

      return err(
        new OrderFullyPaidUseCaseErrors.TokenGenerationError("Unhandled error occurred", {
          cause: error,
        }),
      );
    }
  }
}

export const orderFullyPaidUseCase = new OrderFullyPaidUseCase({
  downloadTokenRepo: downloadTokenRepoImpl,
});
