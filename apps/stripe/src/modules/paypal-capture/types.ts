import { Result } from "neverthrow";
import Stripe from "stripe";

import { StripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";

/** What the A3d worker needs from Stripe: reads only. It never captures or cancels itself. */
export interface IPaypalCaptureStripeApi {
  getPaymentIntent(args: { id: StripePaymentIntentId }): Promise<Result<Stripe.PaymentIntent, unknown>>;
  searchPaymentIntentsAwaitingAppCapture(): Promise<Result<Stripe.PaymentIntent[], unknown>>;
}

/** The subset of the app logger the worker uses (injected in tests). */
export type PaypalCaptureLogger = {
  debug: (message: string, attributes?: Record<string, unknown>) => unknown;
  info: (message: string, attributes?: Record<string, unknown>) => unknown;
  warn: (message: string, attributes?: Record<string, unknown>) => unknown;
  error: (message: string, attributes?: Record<string, unknown>) => unknown;
};
