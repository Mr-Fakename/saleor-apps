import { randomUUID } from "crypto";

import { TransactionEventTypeEnum } from "@/generated/graphql";
import { parseRefundIdFromStripeDashboardUrl } from "@/modules/stripe/generate-stripe-dashboard-urls";
import { StripeMoney } from "@/modules/stripe/stripe-money";
import { StripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";
import { StripeRefundId } from "@/modules/stripe/stripe-refund-id";

/**
 * An event Saleor recorded on the transaction. The TRANSACTION_REFUND_REQUESTED subscription
 * gives only type, pspReference and externalUrl; the app-token query
 * (TransactionEventsFetcher) also gives amount and createdAt.
 */
export type RecordedRefundEvidenceEvent = {
  readonly type?: TransactionEventTypeEnum | null;
  readonly pspReference: string;
  readonly externalUrl: string;
  readonly amount?: { readonly amount: number; readonly currency: string } | null;
  readonly createdAt?: string | null;
};

const REFUND_EVENT_TYPES: ReadonlySet<TransactionEventTypeEnum> = new Set<TransactionEventTypeEnum>([
  "REFUND_REQUEST",
  "REFUND_SUCCESS",
  "REFUND_FAILURE",
  "REFUND_REVERSE",
]);

/**
 * How long before the refund Saleor may have created the REFUND_REQUEST that asked for it:
 * Saleor creates the event, then calls the app, which creates the refund within Saleor's
 * 2 + 18 s sync timeout (settings.WEBHOOK_SYNC_TIMEOUT, 3.22.74). Margin for clock skew.
 */
const REQUEST_BEFORE_REFUND_SECONDS = 120;

/**
 * How long after the refund that request may have been made: a retry gets back the refund an
 * earlier attempt created while Stripe keeps the idempotency key (24 h). Margin for clock skew.
 */
const REQUEST_AFTER_REFUND_SECONDS = 24 * 3600 + 120;

const sameAmount = (
  recorded: NonNullable<RecordedRefundEvidenceEvent["amount"]>,
  stripeRefund: { amount: number; currency: string },
) => {
  if (recorded.currency.toLowerCase() !== stripeRefund.currency.toLowerCase()) {
    return false;
  }

  const recordedInMinorUnits = StripeMoney.createFromSaleorAmount(recorded);

  return recordedInMinorUnits.isOk() && recordedInMinorUnits.value.amount === stripeRefund.amount;
};

const createdInRequestWindow = (createdAt: string, refundCreatedSeconds: number) => {
  const requestCreatedSeconds = Date.parse(createdAt) / 1000;

  if (Number.isNaN(requestCreatedSeconds)) {
    return false;
  }

  return (
    requestCreatedSeconds >= refundCreatedSeconds - REQUEST_BEFORE_REFUND_SECONDS &&
    requestCreatedSeconds <= refundCreatedSeconds + REQUEST_AFTER_REFUND_SECONDS
  );
};

/**
 * True when Saleor recorded this refund in the PaymentIntent's group, as the app did for the
 * refunds it created before A2e (PaymentIntent as pspReference; deployed 2025-09-20 to A2e):
 *
 * 1. an event under the PaymentIntent names this refund in its externalUrl (how
 *    StripeRefundHandler reported it), or
 * 2. a REFUND_REQUEST under the PaymentIntent with no refund in its externalUrl (the request
 *    whose pspReference Saleor copied from the app's answer) has this refund's amount and was
 *    created in the window of the request that made or got back this refund. Needs amount and
 *    createdAt: only the app-token query has them.
 *
 * An event that names ANOTHER refund belongs to that refund. After A2e no new event goes under
 * the PaymentIntent except through this rule, so it only matches what existed before.
 */
const isRecordedUnderPaymentIntent = (args: {
  stripeRefund: { id: StripeRefundId; amount: number; currency: string; created: number };
  stripePaymentIntentId: StripePaymentIntentId;
  recordedEvents: ReadonlyArray<RecordedRefundEvidenceEvent>;
}) =>
  args.recordedEvents.some((event) => {
    if (
      !event.type ||
      !REFUND_EVENT_TYPES.has(event.type) ||
      event.pspReference !== args.stripePaymentIntentId
    ) {
      return false;
    }

    const namedRefundId = parseRefundIdFromStripeDashboardUrl(event.externalUrl);

    if (namedRefundId !== null) {
      return namedRefundId === args.stripeRefund.id;
    }

    return (
      event.type === "REFUND_REQUEST" &&
      !!event.amount &&
      !!event.createdAt &&
      sameAmount(event.amount, args.stripeRefund) &&
      createdInRequestWindow(event.createdAt, args.stripeRefund.created)
    );
  });

/**
 * The pspReference a refund the app created is tracked under in Saleor (A2e).
 *
 * Saleor 3.22.74 de-duplicates transaction events by (transaction, pspReference, type)
 * (payment/utils.py `get_already_existing_event`; same amount: the earlier event is kept,
 * other amount: INCORRECT_DETAILS) and counts one REFUND_SUCCESS per pspReference, the newest,
 * unless a newer REFUND_FAILURE cancels it (transaction_item_calculations.py). So each Stripe
 * refund has its own pspReference: its Stripe refund id. Saleor also links a REFUND_SUCCESS to
 * its granted refund through the REFUND_REQUEST with the same pspReference
 * (transactionEventReport `get_related_granted_refund`).
 *
 * Exception: a refund Saleor recorded under the PaymentIntent before A2e stays there. Under its
 * re_ id a later REFUND_SUCCESS would be counted a second time and a REFUND_FAILURE would cancel
 * nothing, leaving the failed refund in refundedAmount.
 */
export const resolveStripeRefundPspReference = (args: {
  stripeRefund: { id: StripeRefundId; amount: number; currency: string; created: number };
  stripePaymentIntentId: StripePaymentIntentId;
  recordedEvents: ReadonlyArray<RecordedRefundEvidenceEvent>;
}): StripeRefundId | StripePaymentIntentId =>
  isRecordedUnderPaymentIntent(args) ? args.stripePaymentIntentId : args.stripeRefund.id;

const REFUND_FAILURE_PSP_REFERENCE_PREFIX = "refund-failure-";

/**
 * A pspReference for a REFUND_FAILURE the app answers itself (a refusal, or a Stripe error with
 * no refund created). It never repeats and is never a PaymentIntent or a refund id, so it
 * matches no other event (A2e):
 * - under the PaymentIntent, the failure was newer than the PaymentIntent's REFUND_SUCCESS and
 *   Saleor dropped that real refund from refundedAmount;
 * - repeated (same type, same pspReference), Saleor merged a retry's failure into the earlier
 *   one, so the granted refund's newest event stayed its REFUND_REQUEST: PENDING for good;
 * - without one, Saleor matched it to the oldest failure that has none (e.g. its own timeout
 *   failure), and showed its own message instead of the app's.
 */
export const createRefundFailurePspReference = (): string =>
  `${REFUND_FAILURE_PSP_REFERENCE_PREFIX}${randomUUID()}`;
