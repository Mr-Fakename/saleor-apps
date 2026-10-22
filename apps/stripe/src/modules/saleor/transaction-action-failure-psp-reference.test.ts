import { describe, expect, it } from "vitest";

import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";

import {
  createCancelFailurePspReference,
  createChargeFailurePspReference,
} from "./transaction-action-failure-psp-reference";

describe("transaction action failure pspReferences", () => {
  it.each([
    { name: "CHARGE_FAILURE", create: createChargeFailurePspReference, prefix: "charge-failure-" },
    { name: "CANCEL_FAILURE", create: createCancelFailurePspReference, prefix: "cancel-failure-" },
  ])(
    "gives each $name its own reference, never a PaymentIntent id (Saleor groups events by pspReference)",
    ({ create, prefix }) => {
      const first = create();
      const second = create();

      expect(first).toMatch(
        new RegExp(`^${prefix}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`),
      );
      expect(second).not.toBe(first);
      expect(first.startsWith("pi_")).toBe(false);
      expect(first).not.toBe(mockedStripePaymentIntentId);
    },
  );
});
