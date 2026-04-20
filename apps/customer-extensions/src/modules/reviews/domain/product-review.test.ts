import { describe, expect, it } from "vitest";

import { ProductReview } from "./product-review";
import { createProductId, createUserId } from "@/modules/wishlists/domain/types";
import { createOrderId, createRating } from "./types";

describe("ProductReview", () => {
  const validProductId = createProductId("prod_123");
  const validUserId = createUserId("user_123");
  const validOrderId = createOrderId("order_123");

  const validReviewData = {
    productId: validProductId,
    userId: validUserId,
    orderId: validOrderId,
    userEmail: "user@example.com",
    userName: "Test User",
    rating: 5,
    comment: "This is a great product! I really love it.",
  };

  describe("create", () => {
    it("should create a valid product review", () => {
      const result = ProductReview.create(validReviewData);

      expect(result.isOk()).toBe(true);

      if (result.isOk()) {
        const review = result.value;
        expect(review.productId).toBe(validProductId);
        expect(review.userId).toBe(validUserId);
        expect(review.orderId).toBe(validOrderId);
        expect(review.userEmail).toBe("user@example.com");
        expect(review.userName).toBe("Test User");
        expect(review.rating).toBe(5);
        expect(review.comment).toBe("This is a great product! I really love it.");
        expect(review.verifiedPurchase).toBe(true);
        expect(review.reviewId).toBeDefined();
        expect(review.createdAt).toBeInstanceOf(Date);
        expect(review.modifiedAt).toBeInstanceOf(Date);
      }
    });

    it("should trim whitespace from comment, email, and userName", () => {
      const result = ProductReview.create({
        ...validReviewData,
        comment: "  Great product!  ",
        userEmail: "  user@example.com  ",
        userName: "  Test User  ",
      });

      expect(result.isOk()).toBe(true);

      if (result.isOk()) {
        expect(result.value.comment).toBe("Great product!");
        expect(result.value.userEmail).toBe("user@example.com");
        expect(result.value.userName).toBe("Test User");
      }
    });

    describe("rating validation", () => {
      it("should accept rating of 1", () => {
        const result = ProductReview.create({
          ...validReviewData,
          rating: 1,
        });

        expect(result.isOk()).toBe(true);
      });

      it("should accept rating of 5", () => {
        const result = ProductReview.create({
          ...validReviewData,
          rating: 5,
        });

        expect(result.isOk()).toBe(true);
      });

      it("should accept rating of 3", () => {
        const result = ProductReview.create({
          ...validReviewData,
          rating: 3,
        });

        expect(result.isOk()).toBe(true);
      });

      it("should return error for rating less than 1", () => {
        const result = ProductReview.create({
          ...validReviewData,
          rating: 0,
        });

        expect(result.isErr()).toBe(true);

        if (result.isErr()) {
          expect(result.error.message).toContain("Rating must be between 1 and 5");
        }
      });

      it("should return error for rating greater than 5", () => {
        const result = ProductReview.create({
          ...validReviewData,
          rating: 6,
        });

        expect(result.isErr()).toBe(true);

        if (result.isErr()) {
          expect(result.error.message).toContain("Rating must be between 1 and 5");
        }
      });
    });

    describe("comment validation", () => {
      it("should return error for comment less than 10 characters", () => {
        const result = ProductReview.create({
          ...validReviewData,
          comment: "Too short",
        });

        expect(result.isErr()).toBe(true);

        if (result.isErr()) {
          expect(result.error.message).toContain("must be at least 10 characters");
        }
      });

      it("should accept comment with exactly 10 characters", () => {
        const result = ProductReview.create({
          ...validReviewData,
          comment: "1234567890",
        });

        expect(result.isOk()).toBe(true);
      });

      it("should return error for comment exceeding 1000 characters", () => {
        const longComment = "a".repeat(1001);
        const result = ProductReview.create({
          ...validReviewData,
          comment: longComment,
        });

        expect(result.isErr()).toBe(true);

        if (result.isErr()) {
          expect(result.error.message).toContain("cannot exceed 1000 characters");
        }
      });

      it("should accept comment with exactly 1000 characters", () => {
        const maxComment = "a".repeat(1000);
        const result = ProductReview.create({
          ...validReviewData,
          comment: maxComment,
        });

        expect(result.isOk()).toBe(true);
      });
    });

    describe("userName validation", () => {
      it("should return error for empty userName", () => {
        const result = ProductReview.create({
          ...validReviewData,
          userName: "",
        });

        expect(result.isErr()).toBe(true);

        if (result.isErr()) {
          expect(result.error.message).toContain("User name cannot be empty");
        }
      });

      it("should return error for userName with only whitespace", () => {
        const result = ProductReview.create({
          ...validReviewData,
          userName: "   ",
        });

        expect(result.isErr()).toBe(true);

        if (result.isErr()) {
          expect(result.error.message).toContain("User name cannot be empty");
        }
      });
    });

    describe("userEmail validation", () => {
      it("should return error for empty email", () => {
        const result = ProductReview.create({
          ...validReviewData,
          userEmail: "",
        });

        expect(result.isErr()).toBe(true);

        if (result.isErr()) {
          expect(result.error.message).toContain("Invalid email format");
        }
      });

      it("should return error for email without @ symbol", () => {
        const result = ProductReview.create({
          ...validReviewData,
          userEmail: "invalidemail.com",
        });

        expect(result.isErr()).toBe(true);

        if (result.isErr()) {
          expect(result.error.message).toContain("Invalid email format");
        }
      });

      it("should accept email with @ symbol", () => {
        const result = ProductReview.create({
          ...validReviewData,
          userEmail: "test@example.com",
        });

        expect(result.isOk()).toBe(true);
      });
    });
  });

  describe("fromDatabase", () => {
    it("should create product review from database data", () => {
      const now = new Date();
      const review = ProductReview.fromDatabase({
        reviewId: "rev_123" as any,
        productId: validProductId,
        userId: validUserId,
        orderId: validOrderId,
        userEmail: "user@example.com",
        userName: "Test User",
        rating: createRating(5),
        comment: "Great product!",
        verifiedPurchase: true,
        createdAt: now,
        modifiedAt: now,
      });

      expect(review.reviewId).toBe("rev_123");
      expect(review.productId).toBe(validProductId);
      expect(review.userId).toBe(validUserId);
      expect(review.orderId).toBe(validOrderId);
      expect(review.userEmail).toBe("user@example.com");
      expect(review.userName).toBe("Test User");
      expect(review.rating).toBe(5);
      expect(review.comment).toBe("Great product!");
      expect(review.verifiedPurchase).toBe(true);
      expect(review.createdAt).toBe(now);
      expect(review.modifiedAt).toBe(now);
    });
  });

  describe("toDatabase", () => {
    it("should serialize product review for database storage", () => {
      const result = ProductReview.create(validReviewData);

      expect(result.isOk()).toBe(true);

      if (result.isOk()) {
        const dbData = result.value.toDatabase();

        expect(dbData).toEqual({
          reviewId: result.value.reviewId,
          productId: validProductId,
          userId: validUserId,
          orderId: validOrderId,
          userEmail: "user@example.com",
          userName: "Test User",
          rating: 5,
          comment: "This is a great product! I really love it.",
          verifiedPurchase: true,
          createdAt: result.value.createdAt,
          modifiedAt: result.value.modifiedAt,
        });
      }
    });
  });

  describe("update", () => {
    it("should update rating", () => {
      const createResult = ProductReview.create(validReviewData);
      expect(createResult.isOk()).toBe(true);

      if (createResult.isOk()) {
        const review = createResult.value;
        const updateResult = review.update({ rating: 4 });

        expect(updateResult.isOk()).toBe(true);

        if (updateResult.isOk()) {
          const updatedReview = updateResult.value;
          expect(updatedReview.rating).toBe(4);
          expect(updatedReview.comment).toBe(review.comment);
          expect(updatedReview.reviewId).toBe(review.reviewId);
          expect(updatedReview.createdAt).toBe(review.createdAt);
          expect(updatedReview.modifiedAt.getTime()).toBeGreaterThanOrEqual(
            review.modifiedAt.getTime()
          );
        }
      }
    });

    it("should update comment", () => {
      const createResult = ProductReview.create(validReviewData);
      expect(createResult.isOk()).toBe(true);

      if (createResult.isOk()) {
        const review = createResult.value;
        const newComment = "Updated review comment with more details.";
        const updateResult = review.update({ comment: newComment });

        expect(updateResult.isOk()).toBe(true);

        if (updateResult.isOk()) {
          const updatedReview = updateResult.value;
          expect(updatedReview.comment).toBe(newComment);
          expect(updatedReview.rating).toBe(review.rating);
        }
      }
    });

    it("should update both rating and comment", () => {
      const createResult = ProductReview.create(validReviewData);
      expect(createResult.isOk()).toBe(true);

      if (createResult.isOk()) {
        const review = createResult.value;
        const newComment = "Changed my mind about this product.";
        const updateResult = review.update({ rating: 2, comment: newComment });

        expect(updateResult.isOk()).toBe(true);

        if (updateResult.isOk()) {
          const updatedReview = updateResult.value;
          expect(updatedReview.rating).toBe(2);
          expect(updatedReview.comment).toBe(newComment);
        }
      }
    });

    it("should return error for invalid rating in update", () => {
      const createResult = ProductReview.create(validReviewData);
      expect(createResult.isOk()).toBe(true);

      if (createResult.isOk()) {
        const review = createResult.value;
        const updateResult = review.update({ rating: 6 });

        expect(updateResult.isErr()).toBe(true);

        if (updateResult.isErr()) {
          expect(updateResult.error.message).toContain("Rating must be between 1 and 5");
        }
      }
    });

    it("should return error for invalid comment in update", () => {
      const createResult = ProductReview.create(validReviewData);
      expect(createResult.isOk()).toBe(true);

      if (createResult.isOk()) {
        const review = createResult.value;
        const updateResult = review.update({ comment: "Too short" });

        expect(updateResult.isErr()).toBe(true);

        if (updateResult.isErr()) {
          expect(updateResult.error.message).toContain("must be at least 10 characters");
        }
      }
    });
  });
});
