import { z } from "zod";

/**
 * Branded types for Wishlist domain to ensure type safety
 */

// Wishlist ID
const wishlistIdSchema = z.string().uuid().brand("WishlistId");
export type WishlistId = z.infer<typeof wishlistIdSchema>;

export const createWishlistId = (raw: string): WishlistId => {
  return wishlistIdSchema.parse(raw);
};

export const generateWishlistId = (): WishlistId => {
  return createWishlistId(crypto.randomUUID());
};

// User ID
const userIdSchema = z.string().min(1).brand("UserId");
export type UserId = z.infer<typeof userIdSchema>;

export const createUserId = (raw: string): UserId => {
  return userIdSchema.parse(raw);
};

// Product ID
const productIdSchema = z.string().min(1).brand("ProductId");
export type ProductId = z.infer<typeof productIdSchema>;

export const createProductId = (raw: string): ProductId => {
  return productIdSchema.parse(raw);
};

// Variant ID
const variantIdSchema = z.string().min(1).brand("VariantId");
export type VariantId = z.infer<typeof variantIdSchema>;

export const createVariantId = (raw: string): VariantId => {
  return variantIdSchema.parse(raw);
};

// Product Slug
const productSlugSchema = z.string().min(1).max(255).brand("ProductSlug");
export type ProductSlug = z.infer<typeof productSlugSchema>;

export const createProductSlug = (raw: string): ProductSlug => {
  return productSlugSchema.parse(raw);
};
