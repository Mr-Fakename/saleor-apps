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
import { getFileUrls, type FileMetadata } from "./file-utils";
import { fetchProductAttributes } from "./fetch-product-attributes";
import {
  generateCortexAdminNotificationEmail,
  type CortexProduct,
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
  saleorApiUrl: string;
  authToken: string;
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
 * Checks if a product is a Cortex product
 *
 * A product is considered a Cortex product if:
 * 1. Product Type name contains "Capture" (case-insensitive)
 * 2. Has a platform attribute with value "Cortex" (case-insensitive)
 */
function isCortexProduct(line: any): boolean {
  const product = line?.variant?.product;
  const productTypeName = product?.productType?.name || "";

  logger.debug("Checking if product is Cortex product", {
    productName: line?.productName,
    productType: productTypeName,
    variantAttributesCount: line?.variant?.attributes?.length || 0,
    productAttributesCount: product?.attributes?.length || 0,
  });

  // Check if product type name contains "Capture" (more flexible than exact match)
  const isCapture = productTypeName.toLowerCase().includes("capture");

  if (!isCapture) {
    logger.debug("Product is not Cortex - product type doesn't contain 'capture'", {
      productName: line?.productName,
      productType: productTypeName,
    });
    return false;
  }

  // Check for Cortex platform attribute in variant or product attributes
  const variantAttributes = line?.variant?.attributes || [];
  const productAttributes = product?.attributes || [];
  const allAttributes = [...variantAttributes, ...productAttributes];

  logger.debug("Checking attributes for Cortex platform", {
    productName: line?.productName,
    totalAttributes: allAttributes.length,
    attributes: allAttributes.map((attr: any) => ({
      name: attr?.attribute?.name,
      slug: attr?.attribute?.slug,
      values: attr?.values?.map((v: any) => v?.name),
    })),
  });

  // Look for platform attribute with value "Cortex"
  const hasCortex = allAttributes.some((attr: any) => {
    // Check if this is a platform attribute (by name or slug)
    const attrName = attr?.attribute?.name?.toLowerCase() || "";
    const attrSlug = attr?.attribute?.slug?.toLowerCase() || "";
    const isPlatformAttr = attrName === "platform" || attrSlug === "platform";

    if (isPlatformAttr) {
      logger.debug("Found platform attribute", {
        attributeName: attr?.attribute?.name,
        values: attr?.values?.map((v: any) => v?.name),
      });
    }

    return attr?.values?.some((val: any) => {
      const name = val?.name?.toLowerCase() || "";
      return name === "cortex";
    });
  });

  logger.info("Cortex product check result", {
    productName: line?.productName,
    productType: productTypeName,
    isCapture,
    hasCortex,
    isCortexProduct: isCapture && hasCortex,
  });

  return isCapture && hasCortex;
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

      logger.info("Processing ORDER_FULLY_PAID webhook", {
        orderId: order.id,
        orderNumber: order.number,
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

      // Generate download tokens for each digital line
      const tokens: DownloadToken[] = [];

      // Calculate expiry date (null = infinite/never expires)
      const expiryDate = env.DOWNLOAD_TOKEN_EXPIRY_HOURS
        ? new Date(Date.now() + env.DOWNLOAD_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000)
        : null;

      for (const line of digitalLines) {
        // Fetch product attributes from API (webhooks don't include FILE-type attributes reliably)
        const productId = line.variant?.product?.id;
        let productAttributes = undefined;
        
        if (productId) {
          const attributesResult = await fetchProductAttributes(
            input.saleorApiUrl,
            input.authToken,
            productId,
          );

          if (attributesResult.isOk()) {
            productAttributes = attributesResult.value;
          } else {
            logger.warn("Failed to fetch product attributes from API", {
              productId,
              error: attributesResult.error.message,
            });
          }
        }
        
        const fileMetadataList = getFileUrls(line, productAttributes);

        if (fileMetadataList.length === 0) {
          logger.warn("No file URLs found for digital line", {
            orderId: order.id,
            lineId: line.id,
            productName: line.productName,
          });
          continue;
        }

        const totalFiles = fileMetadataList.length;
        const fileGroup = `${line.variant?.product?.id || line.productName}-files`;

        for (let fileIndex = 0; fileIndex < fileMetadataList.length; fileIndex++) {
          const fileMeta = fileMetadataList[fileIndex];
          const fileUrl = fileMeta.url;

          const tokenString = generateDownloadToken({
            orderId: order.id,
            fileUrl: fileUrl,
            expiresAt: expiryDate ? expiryDate.toISOString() : "never",
          });

          const downloadToken = createDownloadToken({
            token: tokenString as DownloadToken["token"],
            orderId: order.id,
            orderNumber: order.number,
            customerId: order.user?.id,
            customerEmail: order.user?.email || order.userEmail || undefined,
            fileUrl: fileUrl,
            productName: line.productName,
            variantName: line.variantName || undefined,
            expiresAt: expiryDate ? expiryDate.toISOString() : undefined,
            maxDownloads: env.MAX_DOWNLOAD_LIMIT ?? undefined,
            fileGroup: fileGroup,
            fileIndex: fileIndex + 1,
            totalFiles: totalFiles,
            fileName: fileMeta.name,
          });

          const saveResult = await this.downloadTokenRepo.save(downloadToken);

          if (saveResult.isErr()) {
            logger.error("Failed to save download token", {
              orderId: order.id,
              lineId: line.id,
              fileName: fileMeta.name,
              error: saveResult.error,
            });
            continue;
          }

          tokens.push(downloadToken);
        }
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

      logger.info("Successfully created download tokens", {
        orderId: order.id,
        orderNumber: order.number,
        tokensCreated: tokens.length,
        digitalProducts: tokens.map(t => ({
          product: t.productName,
          file: t.fileName,
          expiresAt: t.expiresAt,
        })),
      });

      // Send order confirmation email with download links
      const customerEmail = order.user?.email || order.userEmail;
      if (customerEmail && env.EMAIL_ENABLED) {
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
        } else {
          logger.info("Order confirmation email sent", {
            orderId: order.id,
            customerEmail: customerEmail,
          });
        }
      } else if (!customerEmail) {
        logger.warn("No customer email found for order", {
          orderId: order.id,
        });
      }

      // Send admin notification for Cortex products
      logger.info("Checking order for Cortex products", {
        orderId: order.id,
        totalLines: order.lines.length,
        adminEmail: env.ADMIN_EMAIL,
        adminEmailType: typeof env.ADMIN_EMAIL,
        adminEmailDefined: env.ADMIN_EMAIL !== undefined,
        emailEnabled: env.EMAIL_ENABLED,
      });

      const cortexLines = order.lines.filter((line) => isCortexProduct(line));

      logger.info("Cortex product detection complete", {
        orderId: order.id,
        cortexProductsCount: cortexLines.length,
        hasAdminEmail: !!env.ADMIN_EMAIL,
        emailEnabled: env.EMAIL_ENABLED,
      });

      if (cortexLines.length > 0 && env.ADMIN_EMAIL && env.EMAIL_ENABLED) {
        logger.info("Detected Cortex products, sending admin notification", {
          orderId: order.id,
          cortexProductsCount: cortexLines.length,
          adminEmail: env.ADMIN_EMAIL,
        });

        // Extract Cortex Cloud username from order metadata
        const cortexCloudUsername = order.metadata?.find(
          (meta: any) => meta.key === "cortexCloudUsername",
        )?.value;

        logger.info("Extracted Cortex Cloud username from metadata", {
          orderId: order.id,
          cortexCloudUsername: cortexCloudUsername,
          hasUsername: !!cortexCloudUsername,
          allMetadata: order.metadata?.map((m: any) => ({ key: m.key, value: m.value })),
        });

        // Build Cortex products list
        const cortexProducts: CortexProduct[] = cortexLines.map((line) => ({
          productName: line.productName,
          variantName: line.variantName || undefined,
          productType: line.variant?.product?.productType?.name || "Unknown",
          platformAttribute:
            line.variant?.attributes
              ?.concat(line.variant?.product?.attributes || [])
              .flatMap((attr: any) => attr?.values || [])
              .find((val: any) => val?.name?.toLowerCase() === "cortex")?.name || "Cortex",
        }));

        const customerName = order.user?.firstName && order.user?.lastName
          ? `${order.user.firstName} ${order.user.lastName}`
          : order.user?.firstName || order.user?.lastName || undefined;

        const adminEmailTemplate = generateCortexAdminNotificationEmail({
          orderNumber: order.number,
          orderId: order.id,
          customerEmail: customerEmail || order.userEmail || "Unknown",
          customerName,
          cortexCloudUsername,
          cortexProducts,
          orderDate: order.created,
        });

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
        } else {
          logger.info("Cortex admin notification email sent successfully", {
            orderId: order.id,
            adminEmail: env.ADMIN_EMAIL,
            cortexProductsCount: cortexProducts.length,
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
