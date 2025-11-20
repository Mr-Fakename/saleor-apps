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
import {
  generateCortexAdminNotificationEmail,
  type CortexPurchaseInfo,
} from "@/modules/email/cortex-admin-notification-template";

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
 * A product is considered digital if its productType has metadata
 * with key "digital_download" and value "true"
 *
 * This prevents regular products from being treated as digital products
 */
function hasDigitalFiles(line: any): boolean {
  const product = line?.variant?.product;

  // Check Product Type metadata for digital_download flag
  const productTypeMetadata = product?.productType?.metadata || [];
  const hasDigitalFlag = productTypeMetadata.some(
    (meta: any) => meta.key === "digital_download" && meta.value === "true",
  );

  return hasDigitalFlag;
}

/**
 * Checks if a product/variant has the Platform attribute set to "Cortex"
 *
 * Looks for the "Platform" attribute in variant attributes, and checks if any value is "Cortex"
 */
function isCortexPlatform(line: any): boolean {
  // Check variant attributes for Platform=Cortex
  const variantAttributes = line?.variant?.attributes || [];
  for (const attr of variantAttributes) {
    const attributeName = attr?.attribute?.name || "";

    if (attributeName.toLowerCase() === "platform") {
      const values = attr?.values || [];
      for (const value of values) {
        if (value?.name?.toLowerCase() === "cortex") {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Extracts the file URL from a line item
 *
 * Looks for attributes with file-related names (Files, File, Download, etc.)
 * Priority: variant attributes > product attributes > variant media > product media
 */
function getFileUrl(line: any): string | null {
  // File-related attribute names to look for (case-insensitive)
  const fileAttributeNames = [
    "file",
    "files",
    "download",
    "downloads",
    "attachment",
    "attachments",
  ];

  /**
   * Helper to check if an attribute name matches file-related patterns
   */
  const isFileAttribute = (attributeName: string): boolean => {
    const lowerName = attributeName.toLowerCase();
    return fileAttributeNames.some((pattern) => lowerName.includes(pattern));
  };

  // Check 1: Variant attributes with file values (highest priority)
  const variantAttributes = line?.variant?.attributes || [];
  for (const attr of variantAttributes) {
    const attributeName = attr?.attribute?.name || "";

    // Only check attributes with file-related names
    if (isFileAttribute(attributeName)) {
      const values = attr?.values || [];
      for (const value of values) {
        if (value?.file?.url) {
          return value.file.url;
        }
      }
    }
  }

  // Check 2: Product attributes with file values
  const productAttributes = line?.variant?.product?.attributes || [];
  for (const attr of productAttributes) {
    const attributeName = attr?.attribute?.name || "";

    // Only check attributes with file-related names
    if (isFileAttribute(attributeName)) {
      const values = attr?.values || [];
      for (const value of values) {
        if (value?.file?.url) {
          return value.file.url;
        }
      }
    }
  }

  // Check 3: Variant media
  const variantMedia = line?.variant?.media || [];
  if (variantMedia.length > 0) {
    return variantMedia[0]?.url || null;
  }

  // Check 4: Product media (lowest priority)
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

      // Debug: Log all order lines and their metadata
      order.lines.forEach((line, index) => {
        logger.debug("Order line details", {
          lineIndex: index,
          lineId: line.id,
          productName: line.productName,
          variantName: line.variantName,
          variantId: line.variant?.id,
          productId: line.variant?.product?.id,
          productTypeName: line.variant?.product?.productType?.name,
          productTypeMetadata: line.variant?.product?.productType?.metadata,
          productMetadata: line.variant?.product?.metadata,
          productAttributes: line.variant?.product?.attributes,
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
          customerEmail: order.user?.email || order.userEmail || undefined,
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
        const displayEmail = order.user?.email || order.userEmail || "Guest";
        console.log("\n╔═══════════════════════════════════════════════════════════════════");
        console.log("║ 🔗 DOWNLOAD LINK CREATED");
        console.log("╠═══════════════════════════════════════════════════════════════════");
        console.log(`║ Product: ${line.productName}`);
        if (line.variantName) {
          console.log(`║ Variant: ${line.variantName}`);
        }
        console.log(`║ Order: ${order.number}`);
        console.log(`║ Customer: ${displayEmail}`);
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
      const customerEmail = order.user?.email || order.userEmail;
      if (customerEmail && env.EMAIL_ENABLED) {
        logger.info("Sending order confirmation email", {
          orderId: order.id,
          customerEmail: customerEmail,
          tokensCount: tokens.length,
        });

        const appBaseUrl = env.APP_API_BASE_URL || "http://localhost:3003";
        const emailTemplate = generateOrderConfirmationEmail({
          orderNumber: order.number,
          customerEmail: customerEmail,
          downloadTokens: tokens,
          appBaseUrl: appBaseUrl,
        });

        const emailResult = await emailSender.sendEmail({
          to: customerEmail,
          subject: emailTemplate.subject,
          html: emailTemplate.html,
          text: emailTemplate.text,
        });

        if (emailResult.isErr()) {
          logger.error("Failed to send order confirmation email", {
            orderId: order.id,
            customerEmail: customerEmail,
            error: emailResult.error,
          });
          // Don't fail the whole webhook - tokens were created successfully
          // Email failure is a non-critical error
        } else {
          logger.info("Order confirmation email sent successfully", {
            orderId: order.id,
            customerEmail: customerEmail,
          });
        }
      } else {
        if (!customerEmail) {
          logger.warn("Cannot send email - no customer email found", {
            orderId: order.id,
          });
        } else if (!env.EMAIL_ENABLED) {
          logger.debug("Email sending disabled via EMAIL_ENABLED=false", {
            orderId: order.id,
          });
        }
      }

      // Check if any products are Cortex platform products
      const cortexLines = order.lines.filter((line) => isCortexPlatform(line));

      if (cortexLines.length > 0 && env.ADMIN_EMAIL && env.EMAIL_ENABLED) {
        logger.info("Cortex products detected, sending admin notification", {
          orderId: order.id,
          cortexProductsCount: cortexLines.length,
          adminEmail: env.ADMIN_EMAIL,
        });

        // Extract Cortex username and follow confirmation from order metadata
        const orderMetadata = order.metadata || [];
        const cortexUsername = orderMetadata.find((m: any) => m.key === "cortexCloudUsername")
          ?.value;
        const cortexFollowConfirmed =
          orderMetadata.find((m: any) => m.key === "cortexFollowConfirmed")?.value === "true";

        // Prepare Cortex products info
        const cortexProducts: CortexPurchaseInfo[] = cortexLines.map((line) => ({
          productName: line.productName,
          variantName: line.variantName || undefined,
          price: line.totalPrice?.gross
            ? {
                amount: line.totalPrice.gross.amount,
                currency: line.totalPrice.gross.currency,
              }
            : undefined,
        }));

        // Generate admin notification email
        const adminEmailTemplate = generateCortexAdminNotificationEmail({
          orderNumber: order.number,
          customerEmail: customerEmail || order.userEmail || "Unknown",
          cortexUsername,
          cortexFollowConfirmed: cortexUsername ? cortexFollowConfirmed : undefined,
          orderCreated: order.created,
          cortexProducts,
        });

        // Send admin notification
        const adminEmailResult = await emailSender.sendEmail({
          to: env.ADMIN_EMAIL,
          subject: adminEmailTemplate.subject,
          html: adminEmailTemplate.html,
          text: adminEmailTemplate.text,
        });

        if (adminEmailResult.isErr()) {
          logger.error("Failed to send Cortex admin notification email", {
            orderId: order.id,
            adminEmail: env.ADMIN_EMAIL,
            error: adminEmailResult.error,
          });
          // Don't fail the whole webhook - tokens and customer email were sent successfully
        } else {
          logger.info("Cortex admin notification email sent successfully", {
            orderId: order.id,
            adminEmail: env.ADMIN_EMAIL,
            cortexProductsCount: cortexLines.length,
          });
        }
      } else if (cortexLines.length > 0) {
        logger.debug("Cortex products detected but admin email not configured", {
          orderId: order.id,
          cortexProductsCount: cortexLines.length,
          adminEmailConfigured: !!env.ADMIN_EMAIL,
          emailEnabled: env.EMAIL_ENABLED,
        });
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
