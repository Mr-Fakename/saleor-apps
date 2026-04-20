import { useState, useMemo, useEffect } from "react";
import { Box } from "@saleor/macaw-ui";
import { NextPage } from "next";
import { trpcClient } from "@/modules/trpc/trpc-client";
import { useTranslations, type TranslationKeys } from "@/lib/i18n";

type ReviewStatus = "pending" | "approved" | "deleted";

type Review = {
  reviewId: string;
  productId: string;
  userId: string;
  orderId: string;
  userEmail: string;
  userName: string;
  rating: number;
  comment: string;
  verifiedPurchase: boolean;
  createdAt: string;
  modifiedAt: string;
  status: ReviewStatus;
  deletedAt: string | null;
  productName: string | null;
};

type SortField = "createdAt" | "rating" | "userName" | "productId" | "status";
type SortDirection = "asc" | "desc";
type TabType = "reviews" | "orders";

// Tab Navigation Component
const TabBar = ({
  activeTab,
  onChange,
  showOrdersTab,
  t,
}: {
  activeTab: TabType;
  onChange: (tab: TabType) => void;
  showOrdersTab: boolean;
  t: TranslationKeys;
}) => {
  return (
    <Box
      style={{
        display: "flex",
        gap: "0",
        borderBottom: "2px solid #e0e0e0",
        marginBottom: "24px",
      }}
    >
      <button
        onClick={() => onChange("reviews")}
        style={{
          padding: "12px 24px",
          border: "none",
          background: activeTab === "reviews" ? "#fff" : "transparent",
          borderBottom: activeTab === "reviews" ? "2px solid #2196f3" : "2px solid transparent",
          marginBottom: "-2px",
          cursor: "pointer",
          fontSize: "14px",
          fontWeight: activeTab === "reviews" ? 600 : 400,
          color: activeTab === "reviews" ? "#2196f3" : "#666",
        }}
      >
        {t.tabs.reviewModeration}
      </button>
      {showOrdersTab && (
        <button
          onClick={() => onChange("orders")}
          style={{
            padding: "12px 24px",
            border: "none",
            background: activeTab === "orders" ? "#fff" : "transparent",
            borderBottom: activeTab === "orders" ? "2px solid #2196f3" : "2px solid transparent",
            marginBottom: "-2px",
            cursor: "pointer",
            fontSize: "14px",
            fontWeight: activeTab === "orders" ? 600 : 400,
            color: activeTab === "orders" ? "#2196f3" : "#666",
          }}
        >
          {t.tabs.orderUnlocks}
        </button>
      )}
    </Box>
  );
};

// Review Moderation Panel Component
const ReviewModerationPanel = ({ t }: { t: TranslationKeys }) => {
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [statusFilter, setStatusFilter] = useState<ReviewStatus[]>(["pending", "approved"]);
  const [productNames, setProductNames] = useState<Record<string, string>>({});

  const STATUS_OPTIONS: { value: ReviewStatus; label: string }[] = [
    { value: "pending", label: t.reviews.statusPending },
    { value: "approved", label: t.reviews.statusApproved },
    { value: "deleted", label: t.reviews.statusDeleted },
  ];

  // Fetch all reviews with status filter
  const { data, isLoading, error, refetch } = trpcClient.reviews.getAllReviews.useQuery(
    statusFilter.length > 0 ? { statusFilter } : undefined
  );

  // Fetch product names
  const productNamesQuery = trpcClient.reviews.getProductNames.useQuery(
    {
      productIds: data?.reviews
        .filter((r) => !r.productName)
        .map((r) => r.productId) || [],
    },
    {
      enabled: !!data?.reviews && data.reviews.some((r) => !r.productName),
    }
  );

  // Update product names map when query completes
  useEffect(() => {
    if (productNamesQuery.data?.products) {
      const newNames: Record<string, string> = {};
      productNamesQuery.data.products.forEach((p) => {
        newNames[p.id] = p.name;
      });
      setProductNames((prev) => ({ ...prev, ...newNames }));
    }
  }, [productNamesQuery.data]);

  // Approve mutation
  const approveMutation = trpcClient.reviews.approveReview.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  // Soft delete mutation
  const softDeleteMutation = trpcClient.reviews.softDeleteReview.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  // Hard delete mutation (permanent)
  const hardDeleteMutation = trpcClient.reviews.adminDeleteReview.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  // Sort reviews with pending first by default
  const sortedReviews = useMemo(() => {
    if (!data?.reviews) return [];

    const reviews = [...data.reviews];

    reviews.sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;

      switch (sortField) {
        case "createdAt":
          aVal = new Date(a.createdAt).getTime();
          bVal = new Date(b.createdAt).getTime();
          break;
        case "rating":
          aVal = a.rating;
          bVal = b.rating;
          break;
        case "userName":
          aVal = a.userName.toLowerCase();
          bVal = b.userName.toLowerCase();
          break;
        case "productId":
          aVal = (a.productName || productNames[a.productId] || a.productId).toLowerCase();
          bVal = (b.productName || productNames[b.productId] || b.productId).toLowerCase();
          break;
        case "status":
          // Sort order: pending (0), approved (1), deleted (2)
          const statusOrder = { pending: 0, approved: 1, deleted: 2 };
          aVal = statusOrder[a.status];
          bVal = statusOrder[b.status];
          break;
        default:
          return 0;
      }

      if (aVal < bVal) return sortDirection === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });

    return reviews;
  }, [data?.reviews, sortField, sortDirection, productNames]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  const handleApprove = async (review: Review) => {
    try {
      await approveMutation.mutateAsync({
        productId: review.productId,
        userId: review.userId,
        orderId: review.orderId,
      });
    } catch (err) {
      console.error("Failed to approve review:", err);
      alert(t.reviews.failedToApprove);
    }
  };

  const handleSoftDelete = async (review: Review) => {
    try {
      await softDeleteMutation.mutateAsync({
        productId: review.productId,
        userId: review.userId,
        orderId: review.orderId,
      });
    } catch (err) {
      console.error("Failed to soft delete review:", err);
    }
  };

  const handleHardDelete = async (review: Review) => {
    try {
      await hardDeleteMutation.mutateAsync({
        productId: review.productId,
        userId: review.userId,
        orderId: review.orderId,
      });
    } catch (err) {
      console.error("Failed to permanently delete review:", err);
    }
  };

  const handleStatusFilterChange = (status: ReviewStatus) => {
    setStatusFilter((prev) => {
      if (prev.includes(status)) {
        return prev.filter((s) => s !== status);
      } else {
        return [...prev, status];
      }
    });
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return " \u2195";
    return sortDirection === "asc" ? " \u2191" : " \u2193";
  };

  const getStatusBadge = (status: ReviewStatus) => {
    const styles: Record<ReviewStatus, { bg: string; text: string }> = {
      pending: { bg: "#ff9800", text: "white" },
      approved: { bg: "#4caf50", text: "white" },
      deleted: { bg: "#9e9e9e", text: "white" },
    };

    const labels: Record<ReviewStatus, string> = {
      pending: t.reviews.statusPending,
      approved: t.reviews.statusApproved,
      deleted: t.reviews.statusDeleted,
    };

    return (
      <span
        style={{
          display: "inline-block",
          padding: "4px 8px",
          backgroundColor: styles[status].bg,
          color: styles[status].text,
          borderRadius: "4px",
          fontSize: "12px",
          fontWeight: 500,
        }}
      >
        {labels[status]}
      </span>
    );
  };

  const getProductDisplay = (review: Review) => {
    const name = review.productName || productNames[review.productId];
    if (name) {
      return (
        <div title={`ID: ${review.productId}`} style={{ cursor: "help" }}>
          <div style={{ fontWeight: 500, fontSize: "13px" }}>{name}</div>
          <div style={{ fontSize: "11px", color: "#999", fontFamily: "monospace" }}>
            {review.productId.slice(0, 12)}...
          </div>
        </div>
      );
    }
    return (
      <div
        style={{
          fontSize: "12px",
          fontFamily: "monospace",
          color: "#666",
        }}
      >
        {review.productId.slice(0, 16)}...
      </div>
    );
  };

  const isLoading2 = approveMutation.isLoading || softDeleteMutation.isLoading || hardDeleteMutation.isLoading;

  if (isLoading) {
    return (
      <Box padding={4}>
        <p>{t.common.loading}</p>
      </Box>
    );
  }

  if (error) {
    return (
      <Box padding={4}>
        <p style={{ color: "#d32f2f" }}>{t.reviews.errorLoading}: {error.message}</p>
      </Box>
    );
  }

  return (
    <Box>
      <Box marginBottom={6}>
        <h2 style={{ fontSize: "20px", fontWeight: 600, margin: 0 }}>{t.reviews.title}</h2>
        <p style={{ marginTop: "8px", color: "#666", fontSize: "14px" }}>
          {t.reviews.totalReviews}: {data?.totalReviews || 0}
        </p>
      </Box>

      {/* Status Filter */}
      <Box marginBottom={4} style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <span style={{ fontWeight: 500, fontSize: "14px" }}>{t.reviews.filterByStatus}:</span>
        <div style={{ display: "flex", gap: "8px" }}>
          {STATUS_OPTIONS.map((option) => (
            <label
              key={option.value}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                cursor: "pointer",
                padding: "6px 12px",
                backgroundColor: statusFilter.includes(option.value) ? "#e3f2fd" : "#f5f5f5",
                borderRadius: "4px",
                border: statusFilter.includes(option.value) ? "1px solid #2196f3" : "1px solid #e0e0e0",
                fontSize: "13px",
              }}
            >
              <input
                type="checkbox"
                checked={statusFilter.includes(option.value)}
                onChange={() => handleStatusFilterChange(option.value)}
                style={{ margin: 0 }}
              />
              {option.label}
            </label>
          ))}
        </div>
      </Box>

      <Box
        style={{
          border: "1px solid #e0e0e0",
          borderRadius: "8px",
          overflow: "hidden",
          backgroundColor: "white",
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "14px",
          }}
        >
          <thead>
            <tr style={{ backgroundColor: "#f5f5f5", borderBottom: "2px solid #e0e0e0" }}>
              <th
                style={{
                  padding: "12px 16px",
                  textAlign: "left",
                  fontWeight: 600,
                  cursor: "pointer",
                  userSelect: "none",
                }}
                onClick={() => handleSort("createdAt")}
              >
                {t.reviews.date}{getSortIcon("createdAt")}
              </th>
              <th
                style={{
                  padding: "12px 16px",
                  textAlign: "left",
                  fontWeight: 600,
                  cursor: "pointer",
                  userSelect: "none",
                }}
                onClick={() => handleSort("userName")}
              >
                {t.reviews.user}{getSortIcon("userName")}
              </th>
              <th
                style={{
                  padding: "12px 16px",
                  textAlign: "left",
                  fontWeight: 600,
                  cursor: "pointer",
                  userSelect: "none",
                }}
                onClick={() => handleSort("productId")}
              >
                {t.reviews.product}{getSortIcon("productId")}
              </th>
              <th
                style={{
                  padding: "12px 16px",
                  textAlign: "left",
                  fontWeight: 600,
                  cursor: "pointer",
                  userSelect: "none",
                }}
                onClick={() => handleSort("rating")}
              >
                {t.reviews.rating}{getSortIcon("rating")}
              </th>
              <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600 }}>{t.reviews.comment}</th>
              <th
                style={{
                  padding: "12px 16px",
                  textAlign: "center",
                  fontWeight: 600,
                  cursor: "pointer",
                  userSelect: "none",
                }}
                onClick={() => handleSort("status")}
              >
                {t.reviews.status}{getSortIcon("status")}
              </th>
              <th style={{ padding: "12px 16px", textAlign: "center", fontWeight: 600 }}>{t.reviews.actions}</th>
            </tr>
          </thead>
          <tbody>
            {sortedReviews.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  style={{
                    padding: "32px 16px",
                    textAlign: "center",
                    color: "#666",
                  }}
                >
                  {t.reviews.noReviewsFound}
                </td>
              </tr>
            ) : (
              sortedReviews.map((review) => (
                <tr
                  key={review.reviewId}
                  style={{
                    borderBottom: "1px solid #e0e0e0",
                    backgroundColor:
                      review.status === "deleted"
                        ? "#fafafa"
                        : review.status === "approved"
                        ? "#f8fff8"
                        : "transparent",
                    opacity: review.status === "deleted" ? 0.7 : 1,
                  }}
                >
                  <td style={{ padding: "12px 16px", whiteSpace: "nowrap" }}>
                    <div>{new Date(review.createdAt).toLocaleDateString()}</div>
                    <div style={{ fontSize: "12px", color: "#666" }}>
                      {new Date(review.createdAt).toLocaleTimeString()}
                    </div>
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    <div style={{ fontWeight: 500 }}>{review.userName}</div>
                    <div style={{ fontSize: "12px", color: "#666" }}>{review.userEmail}</div>
                  </td>
                  <td style={{ padding: "12px 16px" }}>{getProductDisplay(review)}</td>
                  <td style={{ padding: "12px 16px" }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      <span style={{ fontSize: "16px", fontWeight: 600 }}>{review.rating}</span>
                      <span style={{ color: "#ffa500" }}>\u2605</span>
                    </div>
                  </td>
                  <td
                    style={{
                      padding: "12px 16px",
                      maxWidth: "400px",
                    }}
                  >
                    <div
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        display: "-webkit-box",
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: "vertical",
                        lineHeight: "1.5",
                      }}
                    >
                      {review.comment}
                    </div>
                  </td>
                  <td style={{ padding: "12px 16px", textAlign: "center" }}>
                    {getStatusBadge(review.status)}
                    {review.deletedAt && (
                      <div style={{ fontSize: "11px", color: "#999", marginTop: "4px" }}>
                        {new Date(review.deletedAt).toLocaleDateString()}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "12px 16px" }}>
                    <div
                      style={{
                        display: "flex",
                        gap: "8px",
                        justifyContent: "center",
                        flexWrap: "wrap",
                      }}
                    >
                      {review.status === "pending" && (
                        <>
                          <button
                            onClick={() => handleApprove(review)}
                            disabled={isLoading2}
                            style={{
                              padding: "6px 12px",
                              backgroundColor: "#4caf50",
                              color: "white",
                              border: "none",
                              borderRadius: "4px",
                              cursor: isLoading2 ? "not-allowed" : "pointer",
                              fontSize: "13px",
                              fontWeight: 500,
                              opacity: isLoading2 ? 0.6 : 1,
                            }}
                          >
                            {t.reviews.pass}
                          </button>
                          <button
                            onClick={() => handleSoftDelete(review)}
                            disabled={isLoading2}
                            style={{
                              padding: "6px 12px",
                              backgroundColor: "#f44336",
                              color: "white",
                              border: "none",
                              borderRadius: "4px",
                              cursor: isLoading2 ? "not-allowed" : "pointer",
                              fontSize: "13px",
                              fontWeight: 500,
                              opacity: isLoading2 ? 0.6 : 1,
                            }}
                          >
                            {t.reviews.delete}
                          </button>
                        </>
                      )}
                      {review.status === "approved" && (
                        <button
                          onClick={() => handleSoftDelete(review)}
                          disabled={isLoading2}
                          style={{
                            padding: "6px 12px",
                            backgroundColor: "#f44336",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: isLoading2 ? "not-allowed" : "pointer",
                            fontSize: "13px",
                            fontWeight: 500,
                            opacity: isLoading2 ? 0.6 : 1,
                          }}
                        >
                          {t.reviews.delete}
                        </button>
                      )}
                      {review.status === "deleted" && (
                        <button
                          onClick={() => handleHardDelete(review)}
                          disabled={isLoading2}
                          style={{
                            padding: "6px 12px",
                            backgroundColor: "#b71c1c",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: isLoading2 ? "not-allowed" : "pointer",
                            fontSize: "13px",
                            fontWeight: 500,
                            opacity: isLoading2 ? 0.6 : 1,
                          }}
                          title={t.reviews.permanentlyDelete}
                        >
                          {t.reviews.permanentlyDelete}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Box>

      <Box marginTop={4}>
        <p style={{ fontSize: "12px", color: "#666", margin: 0 }}>
          {t.reviews.helpText}
        </p>
      </Box>
    </Box>
  );
};

// Order Unlock Panel Component
const OrderUnlockPanel = ({ t }: { t: TranslationKeys }) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch recent orders
  const ordersQuery = trpcClient.reviews.getRecentOrders.useQuery({
    first: 20,
    search: debouncedSearch || undefined,
  });

  // Fetch unlocked orders
  const unlockedOrdersQuery = trpcClient.reviews.getUnlockedOrders.useQuery();

  // Unlock mutation
  const unlockMutation = trpcClient.reviews.unlockOrder.useMutation({
    onSuccess: () => {
      ordersQuery.refetch();
      unlockedOrdersQuery.refetch();
    },
  });

  // Lock mutation
  const lockMutation = trpcClient.reviews.lockOrder.useMutation({
    onSuccess: () => {
      ordersQuery.refetch();
      unlockedOrdersQuery.refetch();
    },
  });

  const unlockedOrderIds = new Set(
    unlockedOrdersQuery.data?.unlockedOrders.map((u) => u.orderId) || []
  );

  const handleUnlock = async (order: {
    id: string;
    number: string;
    customerEmail: string | null;
  }) => {
    try {
      await unlockMutation.mutateAsync({
        orderId: order.id,
        orderNumber: order.number,
        customerEmail: order.customerEmail || "unknown@example.com",
      });
    } catch (err) {
      console.error("Failed to unlock order:", err);
      alert(t.orders.failedToUnlock);
    }
  };

  const handleLock = async (orderId: string) => {
    try {
      await lockMutation.mutateAsync({ orderId });
    } catch (err) {
      console.error("Failed to lock order:", err);
      alert(t.orders.failedToLock);
    }
  };

  const isLoading = unlockMutation.isLoading || lockMutation.isLoading;

  const getUnlockStatusBadge = (isUnlocked: boolean) => {
    return (
      <span
        style={{
          display: "inline-block",
          padding: "4px 8px",
          backgroundColor: isUnlocked ? "#4caf50" : "#9e9e9e",
          color: "white",
          borderRadius: "4px",
          fontSize: "12px",
          fontWeight: 500,
        }}
      >
        {isUnlocked ? t.orders.unlocked : t.orders.locked}
      </span>
    );
  };

  return (
    <Box>
      <Box marginBottom={6}>
        <h2 style={{ fontSize: "20px", fontWeight: 600, margin: 0 }}>{t.orders.title}</h2>
        <p style={{ marginTop: "8px", color: "#666", fontSize: "14px" }}>
          {t.orders.description}
        </p>
      </Box>

      {/* Search Box */}
      <Box marginBottom={4}>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t.orders.searchPlaceholder}
          style={{
            padding: "10px 16px",
            border: "1px solid #e0e0e0",
            borderRadius: "4px",
            fontSize: "14px",
            width: "300px",
          }}
        />
      </Box>

      {/* Recent/Search Results Orders Table */}
      <Box marginBottom={6}>
        <h3 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "12px" }}>
          {debouncedSearch ? t.orders.searchResults : t.orders.recentOrders}
        </h3>
        <Box
          style={{
            border: "1px solid #e0e0e0",
            borderRadius: "8px",
            overflow: "hidden",
            backgroundColor: "white",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "14px",
            }}
          >
            <thead>
              <tr style={{ backgroundColor: "#f5f5f5", borderBottom: "2px solid #e0e0e0" }}>
                <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600 }}>
                  {t.orders.orderNumber}
                </th>
                <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600 }}>
                  {t.reviews.date}
                </th>
                <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600 }}>
                  {t.orders.customer}
                </th>
                <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600 }}>
                  {t.orders.orderStatus}
                </th>
                <th style={{ padding: "12px 16px", textAlign: "center", fontWeight: 600 }}>
                  {t.orders.unlockStatus}
                </th>
                <th style={{ padding: "12px 16px", textAlign: "center", fontWeight: 600 }}>
                  {t.orders.action}
                </th>
              </tr>
            </thead>
            <tbody>
              {ordersQuery.isLoading ? (
                <tr>
                  <td colSpan={6} style={{ padding: "32px 16px", textAlign: "center", color: "#666" }}>
                    {t.orders.loadingOrders}
                  </td>
                </tr>
              ) : ordersQuery.error ? (
                <tr>
                  <td colSpan={6} style={{ padding: "32px 16px", textAlign: "center", color: "#d32f2f" }}>
                    {t.orders.errorLoadingOrders}: {ordersQuery.error.message}
                  </td>
                </tr>
              ) : ordersQuery.data?.orders.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: "32px 16px", textAlign: "center", color: "#666" }}>
                    {t.orders.noOrdersFound}
                  </td>
                </tr>
              ) : (
                ordersQuery.data?.orders.map((order) => {
                  const isUnlocked = unlockedOrderIds.has(order.id);
                  return (
                    <tr key={order.id} style={{ borderBottom: "1px solid #e0e0e0" }}>
                      <td style={{ padding: "12px 16px", fontWeight: 500 }}>{order.number}</td>
                      <td style={{ padding: "12px 16px" }}>
                        {new Date(order.created).toLocaleDateString()}
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <div style={{ fontWeight: 500 }}>{order.customerName || "-"}</div>
                        <div style={{ fontSize: "12px", color: "#666" }}>
                          {order.customerEmail || "-"}
                        </div>
                      </td>
                      <td style={{ padding: "12px 16px" }}>{order.status}</td>
                      <td style={{ padding: "12px 16px", textAlign: "center" }}>
                        {getUnlockStatusBadge(isUnlocked)}
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "center" }}>
                        {isUnlocked ? (
                          <button
                            onClick={() => handleLock(order.id)}
                            disabled={isLoading}
                            style={{
                              padding: "6px 12px",
                              backgroundColor: "#f44336",
                              color: "white",
                              border: "none",
                              borderRadius: "4px",
                              cursor: isLoading ? "not-allowed" : "pointer",
                              fontSize: "13px",
                              fontWeight: 500,
                              opacity: isLoading ? 0.6 : 1,
                            }}
                          >
                            {t.orders.lock}
                          </button>
                        ) : (
                          <button
                            onClick={() =>
                              handleUnlock({
                                id: order.id,
                                number: order.number,
                                customerEmail: order.customerEmail,
                              })
                            }
                            disabled={isLoading}
                            style={{
                              padding: "6px 12px",
                              backgroundColor: "#4caf50",
                              color: "white",
                              border: "none",
                              borderRadius: "4px",
                              cursor: isLoading ? "not-allowed" : "pointer",
                              fontSize: "13px",
                              fontWeight: 500,
                              opacity: isLoading ? 0.6 : 1,
                            }}
                          >
                            {t.orders.unlock}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </Box>
      </Box>

      {/* Already Unlocked Orders Section */}
      <Box>
        <h3 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "12px" }}>
          {t.orders.unlockedOrders} ({unlockedOrdersQuery.data?.unlockedOrders.length || 0})
        </h3>
        <Box
          style={{
            border: "1px solid #e0e0e0",
            borderRadius: "8px",
            overflow: "hidden",
            backgroundColor: "white",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "14px",
            }}
          >
            <thead>
              <tr style={{ backgroundColor: "#f5f5f5", borderBottom: "2px solid #e0e0e0" }}>
                <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600 }}>
                  {t.orders.orderNumber}
                </th>
                <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600 }}>
                  {t.orders.customerEmail}
                </th>
                <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600 }}>
                  {t.orders.unlockedAt}
                </th>
                <th style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600 }}>
                  {t.orders.unlockedBy}
                </th>
                <th style={{ padding: "12px 16px", textAlign: "center", fontWeight: 600 }}>
                  {t.orders.action}
                </th>
              </tr>
            </thead>
            <tbody>
              {unlockedOrdersQuery.isLoading ? (
                <tr>
                  <td colSpan={5} style={{ padding: "32px 16px", textAlign: "center", color: "#666" }}>
                    {t.orders.loadingUnlockedOrders}
                  </td>
                </tr>
              ) : unlockedOrdersQuery.error ? (
                <tr>
                  <td colSpan={5} style={{ padding: "32px 16px", textAlign: "center", color: "#d32f2f" }}>
                    {t.orders.errorLoadingUnlockedOrders}: {unlockedOrdersQuery.error.message}
                  </td>
                </tr>
              ) : unlockedOrdersQuery.data?.unlockedOrders.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: "32px 16px", textAlign: "center", color: "#666" }}>
                    {t.orders.noUnlockedOrders}
                  </td>
                </tr>
              ) : (
                unlockedOrdersQuery.data?.unlockedOrders.map((unlock) => (
                  <tr key={unlock.orderId} style={{ borderBottom: "1px solid #e0e0e0" }}>
                    <td style={{ padding: "12px 16px", fontWeight: 500 }}>{unlock.orderNumber}</td>
                    <td style={{ padding: "12px 16px" }}>{unlock.customerEmail}</td>
                    <td style={{ padding: "12px 16px" }}>
                      {new Date(unlock.unlockedAt).toLocaleDateString()}{" "}
                      {new Date(unlock.unlockedAt).toLocaleTimeString()}
                    </td>
                    <td style={{ padding: "12px 16px" }}>{unlock.unlockedByEmail}</td>
                    <td style={{ padding: "12px 16px", textAlign: "center" }}>
                      <button
                        onClick={() => handleLock(unlock.orderId)}
                        disabled={isLoading}
                        style={{
                          padding: "6px 12px",
                          backgroundColor: "#f44336",
                          color: "white",
                          border: "none",
                          borderRadius: "4px",
                          cursor: isLoading ? "not-allowed" : "pointer",
                          fontSize: "13px",
                          fontWeight: 500,
                          opacity: isLoading ? 0.6 : 1,
                        }}
                      >
                        {t.orders.lock}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Box>
      </Box>
    </Box>
  );
};

// Main Dashboard Page
const DashboardPage: NextPage = () => {
  const [activeTab, setActiveTab] = useState<TabType>("reviews");
  const t = useTranslations();

  // Fetch feature config to determine if Orders tab should be shown
  const featureConfigQuery = trpcClient.reviews.getFeatureConfig.useQuery();
  const showOrdersTab = featureConfigQuery.data?.requireOrderUnlockForReviews ?? false;

  return (
    <Box
      padding={8}
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        maxWidth: "100%",
        overflowX: "auto",
      }}
    >
      <Box marginBottom={6}>
        <h1 style={{ fontSize: "24px", fontWeight: 600, margin: 0 }}>{t.dashboard.title}</h1>
      </Box>

      <TabBar activeTab={activeTab} onChange={setActiveTab} showOrdersTab={showOrdersTab} t={t} />

      {activeTab === "reviews" && <ReviewModerationPanel t={t} />}
      {activeTab === "orders" && showOrdersTab && <OrderUnlockPanel t={t} />}
    </Box>
  );
};

export default DashboardPage;
