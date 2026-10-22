import { TransactionRefundRequestedEventFragment } from "@/generated/graphql";
import { parseRefundIdFromStripeDashboardUrl } from "@/modules/stripe/generate-stripe-dashboard-urls";

type SubscribedTransaction = NonNullable<TransactionRefundRequestedEventFragment["transaction"]>;

/** One event Saleor recorded on the transaction (`transaction.events` of the subscription). */
export type RecordedTransactionEvent = SubscribedTransaction["events"][number];

/**
 * TRANSACTION_REFUND_REQUESTED as an installed Saleor sends it. The generated fragment is the
 * subscription of this version of the app; a Saleor whose webhook was registered with an
 * older subscription sends no `grantedRefund` (review M3) and no `transaction.events`
 * (review round 2) until the webhook is updated.
 */
export type TransactionRefundRequestedPayload = Omit<
  TransactionRefundRequestedEventFragment,
  "transaction"
> & {
  transaction?:
    | (Omit<SubscribedTransaction, "events"> & {
        events?: SubscribedTransaction["events"];
      })
    | null;
};

/**
 * True when Saleor already recorded the success of this Stripe refund on the transaction.
 * Since A2e every refund is reported under its own refund ID; a refund the app created before
 * A2e was reported under the PaymentIntent ID, with the refund ID only in `externalUrl`
 * (StripeRefundHandler, resolveStripeRefundPspReference).
 */
export const isRefundRecordedAsSuccess = (
  events: ReadonlyArray<RecordedTransactionEvent>,
  stripeRefundId: string,
): boolean =>
  events.some(
    (event) =>
      event.type === "REFUND_SUCCESS" &&
      (event.pspReference === stripeRefundId ||
        parseRefundIdFromStripeDashboardUrl(event.externalUrl) === stripeRefundId),
  );
