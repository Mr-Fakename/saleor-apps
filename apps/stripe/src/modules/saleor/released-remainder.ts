import { ok, Result } from "neverthrow";
import { z } from "zod";

import { generatePaymentIntentStripeDashboardUrl } from "@/modules/stripe/generate-stripe-dashboard-urls";
import { StripeEnv } from "@/modules/stripe/stripe-env";
import { createStripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";

import { SaleorMoney } from "./saleor-money";
import { TransactionEventReportInput } from "./transaction-event-reporter";

/**
 * pspReference of the CANCEL_SUCCESS that reports what Stripe released after a partial capture:
 * the PaymentIntent id + ":released". Never the PaymentIntent id itself: Saleor groups events by
 * pspReference (payment/transaction_item_calculations.py), and the PaymentIntent id already
 * carries the AUTHORIZATION_SUCCESS / CHARGE_SUCCESS (and a payment_intent.canceled
 * CANCEL_SUCCESS for a full release), which this report must not interfere with.
 */
export const RELEASED_REMAINDER_PSP_REFERENCE_SUFFIX = ":released";

const ReleasedRemainderPspReferenceSchema = z
  .string()
  .startsWith("pi_")
  .endsWith(RELEASED_REMAINDER_PSP_REFERENCE_SUFFIX)
  .brand("ReleasedRemainderPspReference");

export type ReleasedRemainderPspReference = z.infer<typeof ReleasedRemainderPspReferenceSchema>;

export const createReleasedRemainderPspReference = (paymentIntentId: string) =>
  ReleasedRemainderPspReferenceSchema.parse(
    `${paymentIntentId}${RELEASED_REMAINDER_PSP_REFERENCE_SUFFIX}`,
  );

export const RELEASED_REMAINDER_MESSAGE =
  "Uncaptured remainder released by Stripe after a partial capture";

type SucceededPaymentIntentFields = {
  readonly id: string;
  readonly status: string;
  readonly amount: number;
  readonly amount_received: number;
  readonly currency: string;
};

/**
 * Ledger fix for ALL shops (spike S2, 2026-10-23, not gated): after a partial capture (60 of an
 * authorization of 100), Stripe releases the other 40 with no refund.* or charge.* event, and
 * Saleor 3.22.74 keeps the 40 in authorizedAmount: _recalculate_charge_amounts subtracts only
 * the CHARGE_SUCCESS amount from it. A CANCEL_SUCCESS of 40 moves it to canceledAmount
 * (_recalculate_cancel_amounts subtracts it from authorized_value).
 *
 * The report is fully determined by the succeeded PaymentIntent (`amount` and
 * `amount_received` are final once it succeeded; a refund changes neither), so every repeat is
 * identical: Saleor keeps one event per transaction + pspReference + type and answers the
 * others `alreadyProcessed` (graphql/payment/mutations/transaction/transaction_event_report.py,
 * payment/utils.py get_already_existing_event). Nothing to report (null) for a PaymentIntent
 * that is not succeeded or was captured in full.
 *
 * `actions: null`: Saleor keeps the actions the charge answer set ([REFUND]).
 */
export const resolveReleasedRemainderReport = (args: {
  paymentIntent: SucceededPaymentIntentFields;
  saleorTransactionId: string;
  time: Date;
  stripeEnv: StripeEnv;
}): Result<TransactionEventReportInput | null, InstanceType<typeof SaleorMoney.ValidationError>> => {
  const { paymentIntent } = args;

  if (paymentIntent.status !== "succeeded") {
    return ok(null);
  }

  const releasedMinor = paymentIntent.amount - paymentIntent.amount_received;

  if (releasedMinor <= 0) {
    return ok(null);
  }

  const paymentIntentId = createStripePaymentIntentId(paymentIntent.id);

  return SaleorMoney.createFromStripe({
    amount: releasedMinor,
    currency: paymentIntent.currency,
  }).map((amount) => ({
    transactionId: args.saleorTransactionId,
    type: "CANCEL_SUCCESS" as const,
    amount,
    pspReference: createReleasedRemainderPspReference(paymentIntentId),
    message: RELEASED_REMAINDER_MESSAGE,
    time: args.time.toISOString(),
    actions: null,
    externalUrl: generatePaymentIntentStripeDashboardUrl(paymentIntentId, args.stripeEnv),
  }));
};
