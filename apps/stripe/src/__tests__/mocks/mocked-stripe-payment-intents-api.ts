import { vi } from "vitest";

import { IStripePaymentIntentsApi } from "@/modules/stripe/types";

export const mockedStripePaymentIntentsApi = {
  createPaymentIntent: vi.fn(),
  getPaymentIntent: vi.fn(),
  capturePaymentIntent: vi.fn(),
  cancelPaymentIntent: vi.fn(),
  searchPaymentIntentsByCheckout: vi.fn(),
} satisfies IStripePaymentIntentsApi;
