import { err, ok, Result } from "neverthrow";
import Stripe from "stripe";

import { BaseError } from "@/lib/errors";
import { SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { SaleorMoney } from "@/modules/saleor/saleor-money";
import { generateRefundStripeDashboardUrl } from "@/modules/stripe/generate-stripe-dashboard-urls";
import { StripeEnv } from "@/modules/stripe/stripe-env";
import {
  createStripePaymentIntentId,
  StripePaymentIntentId,
} from "@/modules/stripe/stripe-payment-intent-id";
import { createStripeRefundId } from "@/modules/stripe/stripe-refund-id";
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
    >
  | TransactionRecorderError;

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

  async processRefundEvent({
    event,
    stripeEnv,
    transactionRecorder,
    appId,
    saleorApiUrl,
  }: {
    event: Stripe.Event;
    stripeEnv: StripeEnv;
    transactionRecorder: TransactionRecorderRepo;
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

    /*
     * Refunds started from Saleor report under the Payment Intent ID: Saleor matched the
     * REFUND_REQUEST event it created with that pspReference, and a mismatch would leave
     * that request pending forever.
     *
     * Refunds created outside of Saleor have no request event to match, so they report
     * under the refund ID - which also keeps several external refunds of the same intent
     * distinct (Saleor deduplicates events by pspReference + type).
     */
    const pspReference = StripeRefundHandler.isCreatedBySaleor(refund)
      ? stripePaymentIntentIdResult.value
      : refundId;

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

    return ok(
      new TransactionEventReportVariablesResolver({
        transactionResult: mapRefundStatusToTransactionResult(refundStatus),
        stripeObjectId: pspReference,
        saleorTransactionId: recordedTransactionResult.value.saleorTransactionId,
        saleorMoney,
        timestamp,
        externalUrl: generateRefundStripeDashboardUrl(refundId, stripeEnv),
      }),
    );
  }
}
