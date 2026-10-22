import { describe, expect, it } from "vitest";

import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { mockedStripeRefundId } from "@/__tests__/mocks/mocked-stripe-refund-id";

import {
  generatePaymentIntentStripeDashboardUrl,
  generateRefundStripeDashboardUrl,
  parseRefundIdFromStripeDashboardUrl,
} from "./generate-stripe-dashboard-urls";

describe("parseRefundIdFromStripeDashboardUrl", () => {
  it.each(["LIVE", "TEST"] as const)(
    "reads the refund ID back from a %s refund URL",
    (stripeEnv) => {
      const url = generateRefundStripeDashboardUrl(mockedStripeRefundId, stripeEnv);

      expect(parseRefundIdFromStripeDashboardUrl(url)).toBe(mockedStripeRefundId);
    },
  );

  it.each([
    [
      "a PaymentIntent URL",
      generatePaymentIntentStripeDashboardUrl(mockedStripePaymentIntentId, "LIVE"),
    ],
    ["an empty URL", ""],
    ["another host", "https://evil.example/refunds/re_TEST_TEST_TEST"],
    ["a longer path", "https://dashboard.stripe.com/refunds/re_TEST_TEST_TEST/edit"],
  ])("returns null for %s", (_case, url) => {
    expect(parseRefundIdFromStripeDashboardUrl(url)).toBeNull();
  });
});
