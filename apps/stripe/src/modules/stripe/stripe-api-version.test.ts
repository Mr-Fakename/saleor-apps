import { describe, expect, it } from "vitest";

import { STRIPE_API_VERSION } from "./stripe-api-version";

/*
 * Endive guard (A3c §2d). The PayPal-fee gate creates PayPal-only PaymentIntents with
 * `payment_method_types: ["paypal"]`, which Stripe API `2026-09-30.endive` removes. Upgrading the
 * API version must fail here first, so that the gate is reworked in the same change.
 */
describe("STRIPE_API_VERSION", () => {
  it("is pinned to 2025-10-29.clover", () => {
    expect(STRIPE_API_VERSION).toBe("2025-10-29.clover");
  });
});
