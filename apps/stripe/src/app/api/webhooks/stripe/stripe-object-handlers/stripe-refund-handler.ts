import { err, ok, Result } from "neverthrow";
import Stripe from "stripe";

import { BaseError } from "@/lib/errors";
import { resolveStripeRefundPspReference } from "@/modules/saleor/refund-psp-reference";
import { SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { SaleorMoney } from "@/modules/saleor/saleor-money";
import {
  ITransactionEventsFetcher,
  TransactionEventsFetcherErrors,
} from "@/modules/saleor/transaction-events-fetcher";
import { generateRefundStripeDashboardUrl } from "@/modules/stripe/generate-stripe-dashboard-urls";
import { StripeEnv } from "@/modules/stripe/stripe-env";
import {
  createStripePaymentIntentId,
  StripePaymentIntentId,
} from "@/modules/stripe/stripe-payment-intent-id";
import { createStripeRefundId, StripeRefundId } from "@/modules/stripe/stripe-refund-id";
import { createStripeRefundStatus } from "@/modules/stripe/stripe-refund-status";
import { createTimestampFromStripeEvent } from "@/modules/stripe/stripe-timestamps";
import { AllowedStripeObjectMetadata } from "@/modules/stripe/types";
import { mapRefundStatusToTransactionResult } from "@/modules/transaction-result/map-refund-status-to-transaction-result";
import {
  TransactionRecorderError,
  TransactionRecorderRepo,
} from "@/modules/transactions-recording/repositories/transaction-recorder-repo";

import { TransactionEventReportVariablesResolver } from "../transaction-event-report-variables-resolver";

export type StripeChargeHandlerSupportedEvents =
  | Stripe.ChargeRefundUpdatedEvent
  | Stripe.RefundCreatedEvent
  | Stripe.RefundUpdatedEvent
  | Stripe.RefundFailedEvent;

const SUPPORTED_EVENT_TYPES: StripeChargeHandlerSupportedEvents["type"][] = [
  "charge.refund.updated",
  "refund.created",
  "refund.updated",
  "refund.failed",
];

type PossibleErrors =
  | InstanceType<
      | typeof SaleorMoney.ValidationError
      | typeof StripeRefundHandler.NotSupportedEventError
      | typeof StripeRefundHandler.MalformedEventError
      | typeof StripeRefundHandler.RefundRequestNotTaggedYetError
      | typeof TransactionEventsFetcherErrors.FetchError
    >
  | TransactionRecorderError;

/**
 * How long after its creation a refund the app created may wait for Saleor to tag its
 * REFUND_REQUEST with the refund id (A2e round 2, P1). When the app answers
 * TRANSACTION_REFUND_REQUESTED with HTTP 5xx (unknown Stripe outcome), Saleor 3.22.74 re-sends
 * it 5 times, 10 * 2^n s apart (webhook/transport/synchronous/transport.py
 * handle_transaction_request_task, webhook/transport/utils.py handle_webhook_retry): 310 s of
 * back-off, plus up to 6 attempts of at most about 13 s each (StripeRefundsApi) and the Celery
 * queue delay. Past this age Saleor no longer tags the request, so the report goes ahead.
 */
const SALEOR_REQUEST_TAGGING_WINDOW_SECONDS = 600;

export class StripeRefundHandler {
  static NotSupportedEventError = BaseError.subclass("NotSupportedEventError", {
    props: {
      __internalName: "StripeRefundHandler.NotSupportedEventError",
    },
  });

  static MalformedEventError = BaseError.subclass("MalformedEventError", {
    props: {
      __internalName: "StripeRefundHandler.MalformedEventError",
    },
  });

  /**
   * Retryable: Saleor has not tagged the refund request yet, so a report now would not be
   * linked to its granted refund. The webhook answers non-2xx and Stripe re-sends the event.
   */
  static RefundRequestNotTaggedYetError = BaseError.subclass("RefundRequestNotTaggedYetError", {
    props: {
      __internalName: "StripeRefundHandler.RefundRequestNotTaggedYetError",
    },
  });

  private prepareTransactionEventReportParams(event: StripeChargeHandlerSupportedEvents) {
    const refundObject = event.data.object;
    const currency = refundObject.currency;
    const timestamp = createTimestampFromStripeEvent(event);

    const saleorMoneyResult = SaleorMoney.createFromStripe({
      amount: refundObject.amount,
      currency,
    });

    if (saleorMoneyResult.isErr()) {
      return err(saleorMoneyResult.error);
    }

    return ok({
      saleorMoney: saleorMoneyResult.value,
      timestamp,
    });
  }

  private resolvePaymentIntentId(refund: Stripe.Refund) {
    const paymentIntentId = refund.payment_intent;

    if (!paymentIntentId) {
      return err(
        new StripeRefundHandler.MalformedEventError("Refund event does not contain payment_intent"),
      );
    }

    if (typeof paymentIntentId !== "string") {
      return ok(createStripePaymentIntentId(paymentIntentId.id));
    }

    return ok(createStripePaymentIntentId(paymentIntentId));
  }

  private async resolveTransactionRecord({
    transactionRecorder,
    stripePaymentIntentId,
    appId,
    saleorApiUrl,
  }: {
    transactionRecorder: TransactionRecorderRepo;
    stripePaymentIntentId: StripePaymentIntentId;
    appId: string;
    saleorApiUrl: SaleorApiUrl;
  }) {
    const recordedTransactionResult =
      await transactionRecorder.getTransactionByStripePaymentIntentId(
        {
          appId,
          saleorApiUrl,
        },
        stripePaymentIntentId,
      );

    if (recordedTransactionResult.isErr()) {
      return err(recordedTransactionResult.error);
    }

    return ok(recordedTransactionResult.value);
  }

  private checkIfEventIsSupported(
    event: Stripe.Event,
  ): event is StripeChargeHandlerSupportedEvents {
    return (SUPPORTED_EVENT_TYPES as string[]).includes(event.type);
  }

  /**
   * A refund the app itself created carries Saleor metadata; anything else was created
   * outside of Saleor (Stripe Dashboard, Stripe API, dispute handling).
   */
  static isCreatedBySaleor(refund: Stripe.Refund): boolean {
    const metadata = refund.metadata as AllowedStripeObjectMetadata | null;

    return Boolean(metadata?.saleor_transaction_id);
  }

  /**
   * The pspReference to report this refund under (A2e): its own Stripe refund id, except for a
   * refund the app created that Saleor recorded under the PaymentIntent before A2e
   * (resolveStripeRefundPspReference reads that from the transaction's events). A refund
   * created outside Saleor was always reported under its refund id: no lookup.
   */
  private async resolvePspReference({
    refund,
    refundId,
    stripePaymentIntentId,
    saleorTransactionId,
    transactionEventsFetcher,
  }: {
    refund: Stripe.Refund;
    refundId: StripeRefundId;
    stripePaymentIntentId: StripePaymentIntentId;
    saleorTransactionId: string;
    transactionEventsFetcher: ITransactionEventsFetcher;
  }): Promise<
    Result<
      {
        pspReference: StripeRefundId | StripePaymentIntentId;
        /**
         * When Saleor created its REFUND_REQUEST that carries this refund id (newest, in ms),
         * or null: no such request, or the refund stays under the PaymentIntent.
         */
        taggedRequestCreatedAtMs: number | null;
      },
      InstanceType<
        | typeof TransactionEventsFetcherErrors.FetchError
        | typeof StripeRefundHandler.RefundRequestNotTaggedYetError
      >
    >
  > {
    if (!StripeRefundHandler.isCreatedBySaleor(refund)) {
      return ok({ pspReference: refundId, taggedRequestCreatedAtMs: null });
    }

    const eventsResult = await transactionEventsFetcher.fetchTransactionEvents({
      transactionId: saleorTransactionId,
    });

    if (eventsResult.isErr()) {
      return err(eventsResult.error);
    }

    const recordedEvents = eventsResult.value;

    const pspReference = resolveStripeRefundPspReference({
      stripeRefund: {
        id: refundId,
        amount: refund.amount,
        currency: refund.currency,
        created: refund.created,
      },
      stripePaymentIntentId,
      recordedEvents: recordedEvents ?? [],
    });

    /*
     * A2e round 2 (P1): Saleor links this report to its granted refund only through a
     * REFUND_REQUEST that already carries the same pspReference when the report arrives
     * (transaction_event_report.py get_related_granted_refund), never later. Before Saleor tags
     * its request with the refund id (this event beat the app's answer; after a 503, Saleor's
     * re-send arrives with an EMPTY body and tags nothing, saleor/core/models.py:199-203), a
     * report here would stay unlinked: the granted refund would stay PENDING for good, and
     * Saleor refuses to retry or edit it. Deferred
     * instead, while Saleor can still tag the request: Stripe re-sends the event (non-2xx).
     * Not for a refund kept under the PaymentIntent (recorded before A2e), nor when Saleor has
     * no such transaction. Past the window the report goes ahead, so no refund is dropped.
     */
    const refundAgeSeconds = Date.now() / 1000 - refund.created;
    const requestsTaggedWithRefundId = (recordedEvents ?? []).filter(
      (event) => event.type === "REFUND_REQUEST" && event.pspReference === refundId,
    );
    const requestTaggedWithRefundId = requestsTaggedWithRefundId.length > 0;

    if (
      recordedEvents !== null &&
      pspReference === refundId &&
      !requestTaggedWithRefundId &&
      refundAgeSeconds < SALEOR_REQUEST_TAGGING_WINDOW_SECONDS
    ) {
      return err(
        new StripeRefundHandler.RefundRequestNotTaggedYetError(
          `Saleor has not tagged a refund request with ${refundId} yet (refund ${Math.round(refundAgeSeconds)} s old)`,
        ),
      );
    }

    // Saleor's GraphQL createdAt has microseconds; Date.parse keeps whole milliseconds (floor).
    const taggedRequestCreatedAtMs =
      pspReference === refundId
        ? requestsTaggedWithRefundId
            .map((event) => Date.parse(event.createdAt))
            .filter((createdAtMs) => Number.isFinite(createdAtMs))
            .reduce<number | null>(
              (newest, createdAtMs) => (newest === null ? createdAtMs : Math.max(newest, createdAtMs)),
              null,
            )
        : null;

    return ok({ pspReference, taggedRequestCreatedAtMs });
  }

  async processRefundEvent({
    event,
    stripeEnv,
    transactionRecorder,
    transactionEventsFetcher,
    appId,
    saleorApiUrl,
  }: {
    event: Stripe.Event;
    stripeEnv: StripeEnv;
    transactionRecorder: TransactionRecorderRepo;
    /** Reads the Saleor transaction's events with the app token (A2e). */
    transactionEventsFetcher: ITransactionEventsFetcher;
    appId: string;
    saleorApiUrl: SaleorApiUrl;
  }): Promise<Result<TransactionEventReportVariablesResolver, PossibleErrors>> {
    if (!this.checkIfEventIsSupported(event)) {
      return err(new StripeRefundHandler.NotSupportedEventError("Unsupported event type"));
    }

    const refund = event.data.object;

    const stripePaymentIntentIdResult = this.resolvePaymentIntentId(refund);

    if (stripePaymentIntentIdResult.isErr()) {
      return err(stripePaymentIntentIdResult.error);
    }

    const recordedTransactionResult = await this.resolveTransactionRecord({
      transactionRecorder,
      stripePaymentIntentId: stripePaymentIntentIdResult.value,
      appId,
      saleorApiUrl,
    });

    if (recordedTransactionResult.isErr()) {
      return err(recordedTransactionResult.error);
    }

    const paramsResult = this.prepareTransactionEventReportParams(event);

    if (paramsResult.isErr()) {
      return err(paramsResult.error);
    }

    const { saleorMoney, timestamp } = paramsResult.value;

    const refundId = createStripeRefundId(refund.id);

    // Stripe types the status as nullable and can add values; don't let that become a 500 + retry loop.
    let refundStatus;

    try {
      refundStatus = createStripeRefundStatus(refund.status);
    } catch {
      return err(
        new StripeRefundHandler.MalformedEventError(
          `Refund event carries an unsupported status: ${refund.status}`,
        ),
      );
    }

    /*
     * A2e: every refund under its own Stripe refund id. Saleor de-duplicates events by
     * (pspReference, type) and counts one REFUND_SUCCESS per pspReference, so under the
     * PaymentIntent a second refund of one payment was dropped or rejected. A refund started
     * from Saleor still closes the REFUND_REQUEST Saleor created for it: the app answered
     * that request with the same refund id (TransactionRefundRequestedUseCase), and Saleor
     * links this event to its granted refund through it. A failure of Saleor's events query
     * is returned as an error: the webhook answers 500 and Stripe re-sends the event.
     */
    const pspReferenceResult = await this.resolvePspReference({
      refund,
      refundId,
      stripePaymentIntentId: stripePaymentIntentIdResult.value,
      saleorTransactionId: recordedTransactionResult.value.saleorTransactionId,
      transactionEventsFetcher,
    });

    if (pspReferenceResult.isErr()) {
      return err(pspReferenceResult.error);
    }

    const { pspReference, taggedRequestCreatedAtMs } = pspReferenceResult.value;

    /*
     * A2e round 3: the report's `time` becomes the event's created_at in Saleor, and a granted
     * refund's status is its newest related event by created_at (order/utils.py
     * calculate_order_granted_refund_status). Stripe's event time has whole seconds, Saleor's
     * REFUND_REQUEST microseconds: a success in the same second as the request sorted before
     * it and left the granted refund PENDING. So the report is never older than 1 ms after the
     * request it closes. Date.parse floors the microseconds to milliseconds, so + 1 ms is still
     * later than the request; Saleor keeps the milliseconds (graphene 2 DateTime, aniso8601).
     * The same floor for every report of this refund keeps their order (max is monotonic): a
     * later failure is never older than the success, and Saleor lets a failure win a tie
     * (transaction_item_calculations.py `_should_increse_amount`). Only this refund's
     * pspReference group and granted refund compare against this time. Refunds kept under the
     * PaymentIntent and refunds created outside Saleor keep Stripe's time.
     */
    const reportTime =
      taggedRequestCreatedAtMs !== null && taggedRequestCreatedAtMs + 1 > timestamp.getTime()
        ? new Date(taggedRequestCreatedAtMs + 1)
        : timestamp;

    return ok(
      new TransactionEventReportVariablesResolver({
        transactionResult: mapRefundStatusToTransactionResult(refundStatus),
        stripeObjectId: pspReference,
        saleorTransactionId: recordedTransactionResult.value.saleorTransactionId,
        saleorMoney,
        timestamp: reportTime,
        externalUrl: generateRefundStripeDashboardUrl(refundId, stripeEnv),
      }),
    );
  }
}
