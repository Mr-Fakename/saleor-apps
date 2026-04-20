import { err, ok, Result } from "neverthrow";

import { BaseError } from "@/lib/errors";

import { ProductId, ProductSlug, VariantId, WishlistId } from "./types";

export class WishlistItem {
  static ValidationError = BaseError.subclass("WishlistItemValidationError", {
    props: { _brand: "WishlistItem.ValidationError" as const },
  });

  readonly wishlistId: WishlistId;
  readonly productId: ProductId;
  readonly variantId: VariantId;
  readonly productSlug: ProductSlug;
  readonly productName: string; // Denormalized for display
  readonly addedAt: Date;

  private constructor(
    wishlistId: WishlistId,
    productId: ProductId,
    variantId: VariantId,
    productSlug: ProductSlug,
    productName: string,
    addedAt: Date
  ) {
    this.wishlistId = wishlistId;
    this.productId = productId;
    this.variantId = variantId;
    this.productSlug = productSlug;
    this.productName = productName;
    this.addedAt = addedAt;
  }

  static create(args: {
    wishlistId: WishlistId;
    productId: ProductId;
    variantId: VariantId;
    productSlug: ProductSlug;
    productName: string;
  }): Result<WishlistItem, InstanceType<typeof WishlistItem.ValidationError>> {
    // Validate product name
    if (args.productName.length < 1) {
      return err(
        new this.ValidationError("Product name cannot be empty", {
          props: { field: "productName", value: args.productName },
        })
      );
    }

    if (args.productName.length > 255) {
      return err(
        new this.ValidationError("Product name cannot exceed 255 characters", {
          props: { field: "productName", value: args.productName, maxLength: 255 },
        })
      );
    }

    // Validate product slug
    if (args.productSlug.length < 1) {
      return err(
        new this.ValidationError("Product slug cannot be empty", {
          props: { field: "productSlug", value: args.productSlug },
        })
      );
    }

    if (args.productSlug.length > 255) {
      return err(
        new this.ValidationError("Product slug cannot exceed 255 characters", {
          props: { field: "productSlug", value: args.productSlug, maxLength: 255 },
        })
      );
    }

    return ok(
      new WishlistItem(
        args.wishlistId,
        args.productId,
        args.variantId,
        args.productSlug,
        args.productName.trim(),
        new Date()
      )
    );
  }

  /**
   * Creates a WishlistItem instance from database data
   * Used by repository when loading from DynamoDB
   */
  static fromDatabase(data: {
    wishlistId: WishlistId;
    productId: ProductId;
    variantId: VariantId;
    productSlug: ProductSlug;
    productName: string;
    addedAt: Date;
  }): WishlistItem {
    return new WishlistItem(
      data.wishlistId,
      data.productId,
      data.variantId,
      data.productSlug,
      data.productName,
      data.addedAt
    );
  }

  /**
   * Serializes the item for storage
   */
  toDatabase() {
    return {
      wishlistId: this.wishlistId,
      productId: this.productId,
      variantId: this.variantId,
      productSlug: this.productSlug,
      productName: this.productName,
      addedAt: this.addedAt,
    };
  }

  /**
   * Creates a composite key for this item
   * Format: productId#variantId
   */
  getCompositeKey(): string {
    return `${this.productId}#${this.variantId}`;
  }
}
