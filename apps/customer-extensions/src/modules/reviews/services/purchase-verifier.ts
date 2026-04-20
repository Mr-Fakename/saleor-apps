import { err, ok, Result } from "neverthrow";

import { UnknownError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { SaleorClient } from "@/modules/saleor/saleor-client";
import { ProductId, UserId, VariantId } from "@/modules/wishlists/domain/types";

import { createOrderId, OrderId } from "../domain/types";

export class PurchaseVerifier {
  private logger = createLogger("PurchaseVerifier");
  private saleorClient: SaleorClient;

  constructor(saleorClient: SaleorClient) {
    this.saleorClient = saleorClient;
  }

  /**
   * Verifies that a user has purchased a specific product
   * Returns the OrderId if purchase is verified, null if not found
   */
  async verifyProductPurchase(args: {
    userId: UserId;
    productId: ProductId;
    variantId?: VariantId;
  }): Promise<Result<OrderId | null, InstanceType<typeof UnknownError>>> {
    try {
      // Query Saleor for user's orders
      const ordersResult = await this.saleorClient.getUserOrders({
        userId: args.userId,
        first: 50, // Check last 50 orders
      });

      if (ordersResult.isErr()) {
        this.logger.error("Failed to fetch user orders for purchase verification", {
          userId: args.userId,
          error: ordersResult.error,
        });
        return err(ordersResult.error);
      }

      const user = ordersResult.value;

      if (!user || !user.orders) {
        this.logger.warn("User or orders not found", { userId: args.userId });
        return ok(null);
      }

      // Check if any order contains the product
      for (const edge of user.orders.edges) {
        const order = edge.node;

        // Check each line item in the order
        for (const line of order.lines) {
          // Match by product ID
          const productMatches = line.variant?.product?.id === args.productId;

          // If variantId is provided, also match by variant ID
          const variantMatches = args.variantId
            ? line.variant?.id === args.variantId
            : true;

          if (productMatches && variantMatches) {
            this.logger.info("Purchase verified", {
              userId: args.userId,
              productId: args.productId,
              variantId: args.variantId,
              orderId: order.id,
            });

            return ok(createOrderId(order.id));
          }
        }
      }

      // No purchase found
      this.logger.info("No purchase found for product", {
        userId: args.userId,
        productId: args.productId,
        variantId: args.variantId,
      });

      return ok(null);
    } catch (error) {
      this.logger.error("Error verifying product purchase", {
        error,
        userId: args.userId,
        productId: args.productId,
      });

      return err(
        new UnknownError("Failed to verify product purchase", { cause: error })
      );
    }
  }

  /**
   * Checks if a user has already reviewed a product
   * This would be called before allowing a new review
   */
  async hasUserPurchasedProduct(args: {
    userId: UserId;
    productId: ProductId;
    variantId?: VariantId;
  }): Promise<Result<boolean, InstanceType<typeof UnknownError>>> {
    const verificationResult = await this.verifyProductPurchase(args);

    if (verificationResult.isErr()) {
      return err(verificationResult.error);
    }

    return ok(verificationResult.value !== null);
  }
}

/**
 * Factory function to create a PurchaseVerifier instance
 */
export const createPurchaseVerifier = (saleorClient: SaleorClient): PurchaseVerifier => {
  return new PurchaseVerifier(saleorClient);
};
