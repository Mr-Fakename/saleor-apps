export interface TranslationKeys {
  dashboard: {
    title: string;
  };
  tabs: {
    reviewModeration: string;
    orderUnlocks: string;
  };
  reviews: {
    title: string;
    totalReviews: string;
    filterByStatus: string;
    noReviewsFound: string;
    date: string;
    user: string;
    product: string;
    rating: string;
    comment: string;
    status: string;
    actions: string;
    statusPending: string;
    statusApproved: string;
    statusDeleted: string;
    pass: string;
    delete: string;
    permanentlyDelete: string;
    helpText: string;
    errorLoading: string;
    failedToApprove: string;
  };
  orders: {
    title: string;
    description: string;
    searchPlaceholder: string;
    recentOrders: string;
    searchResults: string;
    unlockedOrders: string;
    noOrdersFound: string;
    noUnlockedOrders: string;
    loadingOrders: string;
    loadingUnlockedOrders: string;
    errorLoadingOrders: string;
    errorLoadingUnlockedOrders: string;
    orderNumber: string;
    customerEmail: string;
    customer: string;
    orderStatus: string;
    unlockStatus: string;
    unlockedAt: string;
    unlockedBy: string;
    action: string;
    locked: string;
    unlocked: string;
    unlock: string;
    lock: string;
    failedToUnlock: string;
    failedToLock: string;
  };
  common: {
    loading: string;
    error: string;
  };
}

export const en: TranslationKeys = {
  // Dashboard
  dashboard: {
    title: "Customer Extensions Dashboard",
  },

  // Tabs
  tabs: {
    reviewModeration: "Review Moderation",
    orderUnlocks: "Order Unlocks",
  },

  // Review Moderation
  reviews: {
    title: "Review Moderation",
    totalReviews: "Total reviews",
    filterByStatus: "Filter by status",
    noReviewsFound: "No reviews found",
    // Table headers
    date: "Date",
    user: "User",
    product: "Product",
    rating: "Rating",
    comment: "Comment",
    status: "Status",
    actions: "Actions",
    // Status labels
    statusPending: "Pending",
    statusApproved: "Approved",
    statusDeleted: "Deleted",
    // Actions
    pass: "Pass",
    delete: "Delete",
    permanentlyDelete: "Permanently Delete",
    // Help text
    helpText:
      'Click column headers to sort. Use "Pass" to approve a review or "Delete" to mark it as deleted (soft delete). Deleted reviews are kept for tracking bad users. Use "Permanently Delete" to completely remove a review.',
    // Errors
    errorLoading: "Error loading reviews",
    failedToApprove: "Failed to approve review. Please try again.",
  },

  // Order Unlocks
  orders: {
    title: "Order Unlocks",
    description:
      "Unlock orders to allow customers to submit reviews. Customers cannot review products until their order is unlocked.",
    searchPlaceholder: "Search by order number...",
    recentOrders: "Recent Orders",
    searchResults: "Search Results",
    unlockedOrders: "Unlocked Orders",
    noOrdersFound: "No orders found",
    noUnlockedOrders: "No orders have been unlocked yet",
    loadingOrders: "Loading orders...",
    loadingUnlockedOrders: "Loading unlocked orders...",
    errorLoadingOrders: "Error loading orders",
    errorLoadingUnlockedOrders: "Error loading unlocked orders",
    // Table headers
    orderNumber: "Order #",
    customerEmail: "Customer Email",
    customer: "Customer",
    orderStatus: "Status",
    unlockStatus: "Unlock Status",
    unlockedAt: "Unlocked At",
    unlockedBy: "Unlocked By",
    action: "Action",
    // Status
    locked: "Locked",
    unlocked: "Unlocked",
    // Actions
    unlock: "Unlock",
    lock: "Lock",
    // Errors
    failedToUnlock: "Failed to unlock order. Please try again.",
    failedToLock: "Failed to lock order. Please try again.",
  },

  // Common
  common: {
    loading: "Loading...",
    error: "Error",
  },
};
