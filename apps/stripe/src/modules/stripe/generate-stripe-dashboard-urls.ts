import { StripeEnv } from "@/modules/stripe/stripe-env";
import { StripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";

import { StripeRefundId } from "./stripe-refund-id";

export const generatePaymentIntentStripeDashboardUrl = (
  paymentIntentId: StripePaymentIntentId,
  stripeEnv: StripeEnv,
) => {
  switch (stripeEnv) {
    case "LIVE":
      return `https://dashboard.stripe.com/payments/${encodeURIComponent(paymentIntentId)}`;
    case "TEST":
      return `https://dashboard.stripe.com/test/payments/${encodeURIComponent(paymentIntentId)}`;
  }
};

export const generateRefundStripeDashboardUrl = (
  refundId: StripeRefundId,
  stripeEnv: StripeEnv,
) => {
  switch (stripeEnv) {
    case "LIVE":
      return `https://dashboard.stripe.com/refunds/${encodeURIComponent(refundId)}`;
    case "TEST":
      return `https://dashboard.stripe.com/test/refunds/${encodeURIComponent(refundId)}`;
  }
};

const REFUND_DASHBOARD_URL = /^https:\/\/dashboard\.stripe\.com\/(?:test\/)?refunds\/([^/?#]+)$/;

/**
 * The refund ID in a URL built by generateRefundStripeDashboardUrl, or null for any other
 * URL. A refund the app created before A2e was reported to Saleor under the PaymentIntent ID,
 * so this URL (the event's `externalUrl`) is where Saleor keeps which refund it was.
 */
export const parseRefundIdFromStripeDashboardUrl = (url: string): string | null => {
  const match = REFUND_DASHBOARD_URL.exec(url);

  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
};
