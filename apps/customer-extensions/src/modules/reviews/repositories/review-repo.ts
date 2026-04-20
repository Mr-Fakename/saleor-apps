import { Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { ProductId, UserId } from "@/modules/wishlists/domain/types";

import { ProductReview } from "../domain/product-review";
import { ReviewId, ReviewStatus } from "../domain/types";

export type BaseAccessPattern = {
  saleorApiUrl: string;
  appId: string;
};

export const ReviewRepoError = {
  FailureSavingReview: BaseError.subclass("FailureSavingReviewError", {
    props: {
      _internalName: "ReviewRepoError.FailureSavingReview",
    },
  }),
  FailureFetchingReviews: BaseError.subclass("FailureFetchingReviewsError", {
    props: {
      _internalName: "ReviewRepoError.FailureFetchingReviews",
    },
  }),
  FailureUpdatingReview: BaseError.subclass("FailureUpdatingReviewError", {
    props: {
      _internalName: "ReviewRepoError.FailureUpdatingReview",
    },
  }),
  FailureDeletingReview: BaseError.subclass("FailureDeletingReviewError", {
    props: {
      _internalName: "ReviewRepoError.FailureDeletingReview",
    },
  }),
  FailureApprovingReview: BaseError.subclass("FailureApprovingReviewError", {
    props: {
      _internalName: "ReviewRepoError.FailureApprovingReview",
    },
  }),
  DuplicateReview: BaseError.subclass("DuplicateReviewError", {
    props: {
      _internalName: "ReviewRepoError.DuplicateReview",
    },
  }),
};

export interface ReviewRepo {
  saveReview: (
    access: BaseAccessPattern,
    review: ProductReview
  ) => Promise<Result<null, InstanceType<typeof ReviewRepoError.FailureSavingReview>>>;

  getProductReviews: (
    access: BaseAccessPattern,
    productId: ProductId
  ) => Promise<
    Result<ProductReview[], InstanceType<typeof ReviewRepoError.FailureFetchingReviews>>
  >;

  getUserReviews: (
    access: BaseAccessPattern,
    userId: UserId
  ) => Promise<
    Result<ProductReview[], InstanceType<typeof ReviewRepoError.FailureFetchingReviews>>
  >;

  getReviewById: (
    access: BaseAccessPattern,
    reviewId: ReviewId,
    productId: ProductId
  ) => Promise<
    Result<ProductReview | null, InstanceType<typeof ReviewRepoError.FailureFetchingReviews>>
  >;

  updateReview: (
    access: BaseAccessPattern,
    review: ProductReview
  ) => Promise<Result<null, InstanceType<typeof ReviewRepoError.FailureUpdatingReview>>>;

  deleteReview: (
    access: BaseAccessPattern,
    productId: ProductId,
    userId: UserId,
    orderId: string
  ) => Promise<Result<null, InstanceType<typeof ReviewRepoError.FailureDeletingReview>>>;

  hasUserReviewedProduct: (
    access: BaseAccessPattern,
    userId: UserId,
    productId: ProductId
  ) => Promise<
    Result<boolean, InstanceType<typeof ReviewRepoError.FailureFetchingReviews>>
  >;

  getAllReviews: (
    access: BaseAccessPattern,
    filter?: { status?: ReviewStatus[] }
  ) => Promise<
    Result<ProductReview[], InstanceType<typeof ReviewRepoError.FailureFetchingReviews>>
  >;

  adminDeleteReview: (
    access: BaseAccessPattern,
    productId: ProductId,
    userId: UserId,
    orderId: string
  ) => Promise<Result<null, InstanceType<typeof ReviewRepoError.FailureDeletingReview>>>;

  approveReview: (
    access: BaseAccessPattern,
    productId: ProductId,
    userId: UserId,
    orderId: string
  ) => Promise<Result<null, InstanceType<typeof ReviewRepoError.FailureApprovingReview>>>;

  softDeleteReview: (
    access: BaseAccessPattern,
    productId: ProductId,
    userId: UserId,
    orderId: string
  ) => Promise<Result<null, InstanceType<typeof ReviewRepoError.FailureUpdatingReview>>>;
}
