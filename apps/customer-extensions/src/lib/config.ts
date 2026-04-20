import { env } from "./env";

/**
 * Application configuration derived from environment variables.
 * Provides a cleaner interface for feature toggles and settings.
 */
export const config = {
  /**
   * When true, orders must be manually unlocked by admin before customers can submit reviews.
   * When false, customers can review immediately after purchase (original behavior).
   */
  requireOrderUnlockForReviews: env.REQUIRE_ORDER_UNLOCK_FOR_REVIEWS,
};
