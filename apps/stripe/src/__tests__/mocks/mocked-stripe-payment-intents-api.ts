import { vi } from "vitest";

import { IStripePaymentIntentsApi } from "@/modules/stripe/types";

export const mockedStripePaymentIntentsApi = {
  createPaymentIntent: vi.fn(),
  getPaymentIntent: vi.fn(),
  getPaymentIntentForTransactionAction: vi.fn(),
  updatePaymentIntent: vi.fn(),
  capturePaymentIntent: vi.fn(),
  cancelPaymentIntent: vi.fn(),
  cancelPaymentIntentForTransactionAction: vi.fn(),
  searchPaymentIntentsByCheckout: vi.fn(),
} satisfies IStripePaymentIntentsApi;
