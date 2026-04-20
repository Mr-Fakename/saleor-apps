import { z } from "zod";

/**
 * Branded types for Reviews domain to ensure type safety
 */

// Review Status
export type ReviewStatus = "pending" | "approved" | "deleted";

// Review ID — accepts any 8-4-4-4-12 hex string (not just strict UUID v4)
// to support deterministic IDs from legacy review imports
const reviewIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Invalid review ID format")
  .brand("ReviewId");
export type ReviewId = z.infer<typeof reviewIdSchema>;

export const createReviewId = (raw: string): ReviewId => {
  return reviewIdSchema.parse(raw);
};

export const generateReviewId = (): ReviewId => {
  return createReviewId(crypto.randomUUID());
};

// Rating (1-5)
const ratingSchema = z.number().int().min(1).max(5).brand("Rating");
export type Rating = z.infer<typeof ratingSchema>;

export const createRating = (raw: number): Rating => {
  return ratingSchema.parse(raw);
};

// Order ID
const orderIdSchema = z.string().min(1).brand("OrderId");
export type OrderId = z.infer<typeof orderIdSchema>;

export const createOrderId = (raw: string): OrderId => {
  return orderIdSchema.parse(raw);
};
