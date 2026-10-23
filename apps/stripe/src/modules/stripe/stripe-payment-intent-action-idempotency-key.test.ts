import { describe, expect, it } from "vitest";

import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";

import {
  createStripeCancelIdempotencyKey,
  createStripeCaptureIdempotencyKey,
} from "./stripe-payment-intent-action-idempotency-key";

describe("createStripeCaptureIdempotencyKey", () => {
  it("is capture:v1:<PaymentIntent>:<amount in minor units>", () => {
    expect(
      createStripeCaptureIdempotencyKey({
        stripePaymentIntentId: mockedStripePaymentIntentId,
        amountToCapture: 60_00,
      }),
    ).toBe("capture:v1:pi_TEST_TEST_TEST:6000");
  });

  it("is the same for Saleor's re-sent request (same PaymentIntent, same amount)", () => {
    const args = { stripePaymentIntentId: mockedStripePaymentIntentId, amountToCapture: 60_00 };

    expect(createStripeCaptureIdempotencyKey(args)).toBe(createStripeCaptureIdempotencyKey(args));
  });

  it("differs for another amount, so Stripe never answers idempotency_error for it", () => {
    expect(
      createStripeCaptureIdempotencyKey({
        stripePaymentIntentId: mockedStripePaymentIntentId,
        amountToCapture: 60_00,
      }),
    ).not.toBe(
      createStripeCaptureIdempotencyKey({
        stripePaymentIntentId: mockedStripePaymentIntentId,
        amountToCapture: 100_00,
      }),
    );
  });
});

describe("createStripeCancelIdempotencyKey", () => {
  it("is cancel:v1:<PaymentIntent>:<status the app read before cancelling>", () => {
    expect(
      createStripeCancelIdempotencyKey({
        stripePaymentIntentId: mockedStripePaymentIntentId,
        paymentIntentStatus: "requires_capture",
      }),
    ).toBe("cancel:v1:pi_TEST_TEST_TEST:requires_capture");
  });

  it("is the same for Saleor's re-sent request that reads the same status", () => {
    const args = {
      stripePaymentIntentId: mockedStripePaymentIntentId,
      paymentIntentStatus: "requires_capture" as const,
    };

    expect(createStripeCancelIdempotencyKey(args)).toBe(createStripeCancelIdempotencyKey(args));
  });

  it("differs once the status changed, so Stripe never replays a refusal made from another status", () => {
    expect(
      createStripeCancelIdempotencyKey({
        stripePaymentIntentId: mockedStripePaymentIntentId,
        paymentIntentStatus: "requires_action",
      }),
    ).not.toBe(
      createStripeCancelIdempotencyKey({
        stripePaymentIntentId: mockedStripePaymentIntentId,
        paymentIntentStatus: "requires_capture",
      }),
    );
  });
});
