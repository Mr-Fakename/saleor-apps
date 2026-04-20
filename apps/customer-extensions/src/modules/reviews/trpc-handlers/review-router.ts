import { router } from "@/modules/trpc/trpc-server";

import { SubmitReviewTrpcHandler } from "./submit-review-handler";
import { GetProductReviewsTrpcHandler } from "./get-product-reviews-handler";
import { GetUserReviewsTrpcHandler } from "./get-user-reviews-handler";
import { UpdateReviewTrpcHandler } from "./update-review-handler";
import { DeleteReviewTrpcHandler } from "./delete-review-handler";
import { CanUserReviewTrpcHandler } from "./can-user-review-handler";
import { GetAllReviewsTrpcHandler } from "./get-all-reviews-handler";
import { AdminDeleteReviewTrpcHandler } from "./admin-delete-review-handler";
import { ApproveReviewTrpcHandler } from "./approve-review-handler";
import { SoftDeleteReviewTrpcHandler } from "./soft-delete-review-handler";
import { GetProductNamesTrpcHandler } from "./get-product-names-handler";
import { UnlockOrderTrpcHandler } from "./unlock-order-handler";
import { LockOrderTrpcHandler } from "./lock-order-handler";
import { GetUnlockedOrdersTrpcHandler } from "./get-unlocked-orders-handler";
import { CheckOrderUnlockTrpcHandler } from "./check-order-unlock-handler";
import { GetRecentOrdersTrpcHandler } from "./get-recent-orders-handler";
import { GetFeatureConfigTrpcHandler } from "./get-feature-config-handler";

export const reviewRouter = router({
  submitReview: new SubmitReviewTrpcHandler().getTrpcProcedure(),
  getProductReviews: new GetProductReviewsTrpcHandler().getTrpcProcedure(),
  getUserReviews: new GetUserReviewsTrpcHandler().getTrpcProcedure(),
  updateReview: new UpdateReviewTrpcHandler().getTrpcProcedure(),
  deleteReview: new DeleteReviewTrpcHandler().getTrpcProcedure(),
  canUserReview: new CanUserReviewTrpcHandler().getTrpcProcedure(),
  // Admin endpoints (require staff permissions)
  getAllReviews: new GetAllReviewsTrpcHandler().getTrpcProcedure(),
  adminDeleteReview: new AdminDeleteReviewTrpcHandler().getTrpcProcedure(),
  approveReview: new ApproveReviewTrpcHandler().getTrpcProcedure(),
  softDeleteReview: new SoftDeleteReviewTrpcHandler().getTrpcProcedure(),
  getProductNames: new GetProductNamesTrpcHandler().getTrpcProcedure(),
  // Order unlock endpoints (require staff permissions)
  unlockOrder: new UnlockOrderTrpcHandler().getTrpcProcedure(),
  lockOrder: new LockOrderTrpcHandler().getTrpcProcedure(),
  getUnlockedOrders: new GetUnlockedOrdersTrpcHandler().getTrpcProcedure(),
  checkOrderUnlock: new CheckOrderUnlockTrpcHandler().getTrpcProcedure(),
  getRecentOrders: new GetRecentOrdersTrpcHandler().getTrpcProcedure(),
  getFeatureConfig: new GetFeatureConfigTrpcHandler().getTrpcProcedure(),
});
