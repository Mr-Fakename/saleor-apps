import Stripe from "stripe";

import { PaypalCaptureMode } from "./paypal-capture-config";

type CaptureFields = Pick<Stripe.PaymentIntent, "capture_method" | "payment_method_options">;

/**
 * True when PayPal approval only authorizes this PaymentIntent (A3d). Spike S1 (sandbox,
 * 2026-10-23): created with payment_method_options.paypal.capture_method "manual", the
 * PaymentIntent still reads top-level capture_method "automatic_async"; the PayPal option is what
 * counts. A top-level "manual" applies to every method, PayPal included.
 */
export const isPaypalManualCapture = (paymentIntent: CaptureFields): boolean =>
  paymentIntent.payment_method_options?.paypal?.capture_method === "manual" ||
  paymentIntent.capture_method === "manual";

/**
 * A3d reuse rule for paypal-only PaymentIntents: with manual capture on, only one created for a
 * manual capture may be handed out or get a new amount. One created before (or while the kill
 * switch was on) would be captured by Stripe at approval, before the app checked the order. In
 * any other mode every PaymentIntent matches (the gate before A3d): a manual one created before
 * the kill switch is still captured by the worker.
 */
export const paymentIntentMatchesPaypalCaptureMode = (
  paymentIntent: CaptureFields,
  mode: PaypalCaptureMode | null | undefined,
): boolean => mode !== "manual" || isPaypalManualCapture(paymentIntent);
