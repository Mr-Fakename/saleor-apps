import { err, ok, Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { sanitizeReviewComment, sanitizeUserName, sanitizeEmail } from "@/lib/sanitize";
import { ProductId } from "@/modules/wishlists/domain/types";
import { UserId } from "@/modules/wishlists/domain/types";

import { createRating, generateReviewId, OrderId, Rating, ReviewId, ReviewStatus } from "./types";

export class ProductReview {
  static ValidationError = BaseError.subclass("ProductReviewValidationError", {
    props: { _brand: "ProductReview.ValidationError" as const },
  });

  readonly reviewId: ReviewId;
  readonly productId: ProductId;
  readonly userId: UserId;
  readonly orderId: OrderId;
  readonly userEmail: string; // Denormalized for display
  readonly userName: string; // Denormalized for display
  readonly rating: Rating;
  readonly comment: string;
  readonly verifiedPurchase: boolean;
  readonly createdAt: Date;
  readonly modifiedAt: Date;
  readonly status: ReviewStatus;
  readonly deletedAt: Date | null;
  readonly productName: string | null; // Denormalized for display

  private constructor(
    reviewId: ReviewId,
    productId: ProductId,
    userId: UserId,
    orderId: OrderId,
    userEmail: string,
    userName: string,
    rating: Rating,
    comment: string,
    verifiedPurchase: boolean,
    createdAt: Date,
    modifiedAt: Date,
    status: ReviewStatus,
    deletedAt: Date | null,
    productName: string | null
  ) {
    this.reviewId = reviewId;
    this.productId = productId;
    this.userId = userId;
    this.orderId = orderId;
    this.userEmail = userEmail;
    this.userName = userName;
    this.rating = rating;
    this.comment = comment;
    this.verifiedPurchase = verifiedPurchase;
    this.createdAt = createdAt;
    this.modifiedAt = modifiedAt;
    this.status = status;
    this.deletedAt = deletedAt;
    this.productName = productName;
  }

  static create(args: {
    productId: ProductId;
    userId: UserId;
    orderId: OrderId;
    userEmail: string;
    userName: string;
    rating: number;
    comment: string;
    productName?: string;
  }): Result<ProductReview, InstanceType<typeof ProductReview.ValidationError>> {
    // Trim inputs first
    const trimmedComment = args.comment.trim();
    const trimmedUserName = args.userName.trim();
    const trimmedEmail = args.userEmail.trim();

    // Validate rating (1-5)
    if (args.rating < 1 || args.rating > 5) {
      return err(
        new this.ValidationError("Rating must be between 1 and 5", {
          props: { field: "rating", value: args.rating },
        })
      );
    }

    // Validate comment length (10-1000 characters) BEFORE sanitization
    // This ensures user gets feedback if their content is too long
    if (trimmedComment.length < 10) {
      return err(
        new this.ValidationError("Comment must be at least 10 characters", {
          props: { field: "comment", value: trimmedComment, minLength: 10 },
        })
      );
    }

    if (trimmedComment.length > 1000) {
      return err(
        new this.ValidationError("Comment cannot exceed 1000 characters", {
          props: { field: "comment", value: trimmedComment, maxLength: 1000 },
        })
      );
    }

    // Validate user name
    if (!trimmedUserName || trimmedUserName.length === 0) {
      return err(
        new this.ValidationError("User name cannot be empty", {
          props: { field: "userName", value: trimmedUserName },
        })
      );
    }

    // Validate email format (basic check)
    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      return err(
        new this.ValidationError("Invalid email format", {
          props: { field: "userEmail", value: trimmedEmail },
        })
      );
    }

    // After validation passes, sanitize to prevent XSS attacks
    // Sanitization without max length (we already validated length above)
    const sanitizedComment = sanitizeReviewComment(trimmedComment, 9999);
    const sanitizedUserName = sanitizeUserName(trimmedUserName, 9999);
    const sanitizedEmail = sanitizeEmail(trimmedEmail);

    const now = new Date();

    return ok(
      new ProductReview(
        generateReviewId(),
        args.productId,
        args.userId,
        args.orderId,
        sanitizedEmail,
        sanitizedUserName,
        createRating(args.rating),
        sanitizedComment,
        true, // Verified since we check order ownership
        now,
        now,
        "pending", // New reviews start as pending
        null,
        args.productName ?? null
      )
    );
  }

  /**
   * Creates a ProductReview instance from database data
   * Used by repository when loading from DynamoDB
   */
  static fromDatabase(data: {
    reviewId: ReviewId;
    productId: ProductId;
    userId: UserId;
    orderId: OrderId;
    userEmail: string;
    userName: string;
    rating: Rating;
    comment: string;
    verifiedPurchase: boolean;
    createdAt: Date;
    modifiedAt: Date;
    status?: ReviewStatus;
    deletedAt?: Date | null;
    productName?: string | null;
  }): ProductReview {
    return new ProductReview(
      data.reviewId,
      data.productId,
      data.userId,
      data.orderId,
      data.userEmail,
      data.userName,
      data.rating,
      data.comment,
      data.verifiedPurchase,
      data.createdAt,
      data.modifiedAt,
      data.status ?? "pending", // Backward compatibility: treat undefined as pending
      data.deletedAt ?? null,
      data.productName ?? null
    );
  }

  /**
   * Serializes the review for storage
   */
  toDatabase() {
    return {
      reviewId: this.reviewId,
      productId: this.productId,
      userId: this.userId,
      orderId: this.orderId,
      userEmail: this.userEmail,
      userName: this.userName,
      rating: this.rating,
      comment: this.comment,
      verifiedPurchase: this.verifiedPurchase,
      createdAt: this.createdAt,
      modifiedAt: this.modifiedAt,
      status: this.status,
      deletedAt: this.deletedAt,
      productName: this.productName,
    };
  }

  /**
   * Updates the review with new rating and/or comment
   */
  update(args: {
    rating?: number;
    comment?: string;
  }): Result<ProductReview, InstanceType<typeof ProductReview.ValidationError>> {
    const trimmedNewComment =
      args.comment !== undefined ? args.comment.trim() : this.comment;
    const newRating = args.rating !== undefined ? args.rating : this.rating;

    // Validate rating if provided
    if (args.rating !== undefined && (args.rating < 1 || args.rating > 5)) {
      return err(
        new ProductReview.ValidationError("Rating must be between 1 and 5", {
          props: { field: "rating", value: args.rating },
        })
      );
    }

    // Validate comment if provided - check BEFORE sanitization
    if (args.comment !== undefined) {
      if (trimmedNewComment.length < 10) {
        return err(
          new ProductReview.ValidationError("Comment must be at least 10 characters", {
            props: { field: "comment", value: trimmedNewComment, minLength: 10 },
          })
        );
      }

      if (trimmedNewComment.length > 1000) {
        return err(
          new ProductReview.ValidationError("Comment cannot exceed 1000 characters", {
            props: { field: "comment", value: trimmedNewComment, maxLength: 1000 },
          })
        );
      }
    }

    // After validation, sanitize to prevent XSS
    const sanitizedNewComment =
      args.comment !== undefined ? sanitizeReviewComment(trimmedNewComment, 9999) : this.comment;

    return ok(
      new ProductReview(
        this.reviewId,
        this.productId,
        this.userId,
        this.orderId,
        this.userEmail,
        this.userName,
        args.rating !== undefined ? createRating(newRating) : this.rating,
        sanitizedNewComment,
        this.verifiedPurchase,
        this.createdAt,
        new Date(), // Update modifiedAt
        this.status,
        this.deletedAt,
        this.productName
      )
    );
  }

  /**
   * Returns a new ProductReview with status set to "approved"
   */
  approve(): ProductReview {
    return new ProductReview(
      this.reviewId,
      this.productId,
      this.userId,
      this.orderId,
      this.userEmail,
      this.userName,
      this.rating,
      this.comment,
      this.verifiedPurchase,
      this.createdAt,
      new Date(),
      "approved",
      this.deletedAt,
      this.productName
    );
  }

  /**
   * Returns a new ProductReview with status set to "deleted" and deletedAt timestamp
   */
  softDelete(): ProductReview {
    return new ProductReview(
      this.reviewId,
      this.productId,
      this.userId,
      this.orderId,
      this.userEmail,
      this.userName,
      this.rating,
      this.comment,
      this.verifiedPurchase,
      this.createdAt,
      new Date(),
      "deleted",
      new Date(),
      this.productName
    );
  }
}
