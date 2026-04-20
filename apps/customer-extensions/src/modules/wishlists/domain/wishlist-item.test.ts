import { describe, expect, it } from "vitest";

import { WishlistItem } from "./wishlist-item";
import {
  createWishlistId,
  createProductId,
  createProductSlug,
  createVariantId,
} from "./types";

describe("WishlistItem", () => {
  const validWishlistId = createWishlistId("550e8400-e29b-41d4-a716-446655440000");
  const validProductId = createProductId("UHJvZHVjdDoxMjM=");
  const validVariantId = createVariantId("UHJvZHVjdFZhcmlhbnQ6MTIz");
  const validProductSlug = createProductSlug("test-product");

  describe("create", () => {
    it("should create a valid wishlist item", () => {
      const result = WishlistItem.create({
        wishlistId: validWishlistId,
        productId: validProductId,
        variantId: validVariantId,
        productSlug: validProductSlug,
        productName: "Test Product",
      });

      expect(result.isOk()).toBe(true);

      if (result.isOk()) {
        const item = result.value;
        expect(item.wishlistId).toBe(validWishlistId);
        expect(item.productId).toBe(validProductId);
        expect(item.variantId).toBe(validVariantId);
        expect(item.productSlug).toBe(validProductSlug);
        expect(item.productName).toBe("Test Product");
        expect(item.addedAt).toBeInstanceOf(Date);
      }
    });

    it("should trim whitespace from product name", () => {
      const result = WishlistItem.create({
        wishlistId: validWishlistId,
        productId: validProductId,
        variantId: validVariantId,
        productSlug: validProductSlug,
        productName: "  Test Product  ",
      });

      expect(result.isOk()).toBe(true);

      if (result.isOk()) {
        expect(result.value.productName).toBe("Test Product");
      }
    });

    it("should return error for empty product name", () => {
      const result = WishlistItem.create({
        wishlistId: validWishlistId,
        productId: validProductId,
        variantId: validVariantId,
        productSlug: validProductSlug,
        productName: "",
      });

      expect(result.isErr()).toBe(true);

      if (result.isErr()) {
        expect(result.error.message).toContain("cannot be empty");
      }
    });

    it("should return error for product name exceeding 255 characters", () => {
      const longName = "a".repeat(256);
      const result = WishlistItem.create({
        wishlistId: validWishlistId,
        productId: validProductId,
        variantId: validVariantId,
        productSlug: validProductSlug,
        productName: longName,
      });

      expect(result.isErr()).toBe(true);

      if (result.isErr()) {
        expect(result.error.message).toContain("cannot exceed 255 characters");
      }
    });

    it("should accept product name with exactly 255 characters", () => {
      const maxName = "a".repeat(255);
      const result = WishlistItem.create({
        wishlistId: validWishlistId,
        productId: validProductId,
        variantId: validVariantId,
        productSlug: validProductSlug,
        productName: maxName,
      });

      expect(result.isOk()).toBe(true);
    });
  });

  describe("fromDatabase", () => {
    it("should create wishlist item from database data", () => {
      const now = new Date();
      const item = WishlistItem.fromDatabase({
        wishlistId: validWishlistId,
        productId: validProductId,
        variantId: validVariantId,
        productSlug: validProductSlug,
        productName: "Test Product",
        addedAt: now,
      });

      expect(item.wishlistId).toBe(validWishlistId);
      expect(item.productId).toBe(validProductId);
      expect(item.variantId).toBe(validVariantId);
      expect(item.productSlug).toBe(validProductSlug);
      expect(item.productName).toBe("Test Product");
      expect(item.addedAt).toBe(now);
    });
  });

  describe("toDatabase", () => {
    it("should serialize wishlist item for database storage", () => {
      const result = WishlistItem.create({
        wishlistId: validWishlistId,
        productId: validProductId,
        variantId: validVariantId,
        productSlug: validProductSlug,
        productName: "Test Product",
      });

      expect(result.isOk()).toBe(true);

      if (result.isOk()) {
        const dbData = result.value.toDatabase();

        expect(dbData).toEqual({
          wishlistId: validWishlistId,
          productId: validProductId,
          variantId: validVariantId,
          productSlug: validProductSlug,
          productName: "Test Product",
          addedAt: result.value.addedAt,
        });
      }
    });
  });

  describe("getCompositeKey", () => {
    it("should return composite key in correct format", () => {
      const result = WishlistItem.create({
        wishlistId: validWishlistId,
        productId: validProductId,
        variantId: validVariantId,
        productSlug: validProductSlug,
        productName: "Test Product",
      });

      expect(result.isOk()).toBe(true);

      if (result.isOk()) {
        const compositeKey = result.value.getCompositeKey();
        expect(compositeKey).toBe(`${validProductId}#${validVariantId}`);
      }
    });
  });
});
