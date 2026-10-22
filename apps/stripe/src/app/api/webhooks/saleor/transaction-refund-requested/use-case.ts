import { ObservabilityAttributes } from "@saleor/apps-otel/src/observability-attributes";
import { err, ok, Result } from "neverthrow";

import {
  AppIsNotConfiguredResponse,
  BrokenAppResponse,
  MalformedRequestResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import { appContextContainer } from "@/lib/app-context";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { loggerContext } from "@/lib/logger-context";
import { AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { resolveStripeRefundPspReference } from "@/modules/saleor/refund-psp-reference";
import { SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { saleorGrantedRefundIdFromPayload } from "@/modules/saleor/saleor-granted-refund-id";
import { SaleorMoney } from "@/modules/saleor/saleor-money";
import { createSaleorTransactionId } from "@/modules/saleor/saleor-transaction-id";
import {
  getChannelIdFromRequestedEventPayload,
  getTransactionFromRequestedEventPayload,
} from "@/modules/saleor/transaction-requested-event-helpers";
import {
  mapStripeErrorToApiError,
  StripeIdempotencyError,
} from "@/modules/stripe/stripe-api-error";
import { StripeMoney } from "@/modules/stripe/stripe-money";
import { createStripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";
import { createStripeRefundId } from "@/modules/stripe/stripe-refund-id";
import { createStripeRefundIdempotencyKey } from "@/modules/stripe/stripe-refund-idempotency-key";
import { isStripeOutcomeUnknown } from "@/modules/stripe/stripe-request-outcome";
import { IStripeRefundsApiFactory } from "@/modules/stripe/types";
import { RefundFailureResult } from "@/modules/transaction-result/refund-result";

import { RefundAlreadyRecordedError, RefundRequestChangedError } from "./refund-refusal-errors";
import {
  isRefundRecordedAsSuccess,
  TransactionRefundRequestedPayload,
} from "./refund-requested-payload";
import {
  RefundOutcomeUnknownResponse,
  TransactionRefundRequestedUseCaseResponses,
  TransactionRefundRequestedUseCaseResponsesType,
} from "./use-case-response";

/**
 * A refund created more than this before the request started was not created by it.
 * Leaves room for clock skew between this server and Stripe.
 */
const REPLAY_DETECTION_MARGIN_SECONDS = 30;

type UseCaseExecuteResult = Result<
  TransactionRefundRequestedUseCaseResponsesType,
  | AppIsNotConfiguredResponse
  | BrokenAppResponse
  | MalformedRequestResponse
  | RefundOutcomeUnknownResponse
>;

export class TransactionRefundRequestedUseCase {
  private logger = createLogger("TransactionRefundRequestedUseCase");
  private appConfigRepo: AppConfigRepo;
  private stripeRefundsApiFactory: IStripeRefundsApiFactory;

  constructor(deps: {
    appConfigRepo: AppConfigRepo;
    stripeRefundsApiFactory: IStripeRefundsApiFactory;
  }) {
    this.appConfigRepo = deps.appConfigRepo;
    this.stripeRefundsApiFactory = deps.stripeRefundsApiFactory;
  }

  async execute(args: {
    appId: string;
    saleorApiUrl: SaleorApiUrl;
    event: TransactionRefundRequestedPayload;
  }): Promise<UseCaseExecuteResult> {
    const { appId, saleorApiUrl, event } = args;

    let transaction, channelId;

    try {
      transaction = getTransactionFromRequestedEventPayload(event);
    } catch (error) {
      this.logger.error("Failed to extract transaction from event", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    try {
      channelId = getChannelIdFromRequestedEventPayload(event);
    } catch (error) {
      this.logger.error("Failed to extract channel ID from event", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    // Validate transaction has proper pspReference
    if (!transaction.pspReference) {
      this.logger.error("Transaction missing pspReference", {
        transactionId: transaction.id,
      });

      return err(
        new MalformedRequestResponse(
          appContextContainer.getContextValue(),
          new BaseError("Transaction missing pspReference - cannot process refund"),
        ),
      );
    }

    loggerContext.set(ObservabilityAttributes.PSP_REFERENCE, transaction.pspReference);

    const stripeConfigForThisChannel = await this.appConfigRepo.getStripeConfig({
      channelId,
      appId,
      saleorApiUrl,
    });

    if (stripeConfigForThisChannel.isErr()) {
      this.logger.error("Failed to get Stripe configuration", {
        error: stripeConfigForThisChannel.error.message,
        channelId,
      });

      return err(
        new BrokenAppResponse(
          appContextContainer.getContextValue(),
          stripeConfigForThisChannel.error,
        ),
      );
    }

    if (!stripeConfigForThisChannel.value) {
      this.logger.warn("Stripe configuration not found for channel", {
        channelId,
      });

      return err(
        new AppIsNotConfiguredResponse(
          appContextContainer.getContextValue(),
          new BaseError("Config for channel not found"),
        ),
      );
    }

    appContextContainer.set({
      stripeEnv: stripeConfigForThisChannel.value.getStripeEnvValue(),
    });

    const restrictedKey = stripeConfigForThisChannel.value.restrictedKey;

    const stripeRefundsApi = this.stripeRefundsApiFactory.create({
      key: restrictedKey,
    });

    this.logger.info("Processing Stripe refund", {
      pspReference: transaction.pspReference,
      amount: event.action.amount,
      currency: event.action.currency,
    });

    const stripePaymentIntentId = createStripePaymentIntentId(transaction.pspReference);

    const stripeMoneyResult = StripeMoney.createFromSaleorAmount({
      amount: event.action.amount,
      currency: event.action.currency,
    });

    if (stripeMoneyResult.isErr()) {
      this.logger.error("Invalid refund amount or currency", {
        error: stripeMoneyResult.error.message,
        amount: event.action.amount,
        currency: event.action.currency,
      });

      return err(
        new MalformedRequestResponse(
          appContextContainer.getContextValue(),
          stripeMoneyResult.error,
        ),
      );
    }

    /*
     * Only what stays the same for the life of the transaction (review Low 3). The
     * transaction moves from the checkout to the order when the checkout completes, so
     * `saleor_source_id`/`saleor_source_type` changed between a refund attempt and its retry,
     * and Stripe rejects a reused idempotency key with other parameters. Keying on the source
     * instead would give the retry a new key and refund twice. The refund handler only reads
     * `saleor_transaction_id`.
     */
    const refundMetadata = {
      saleor_transaction_id: createSaleorTransactionId(transaction.id),
    };

    const saleorGrantedRefundId = saleorGrantedRefundIdFromPayload(event.grantedRefund);

    /*
     * Same refund request (Saleor re-send or staff retry) -> same key -> no second refund
     * (NR-32); another granted refund of the same amount -> another key (review M3).
     */
    const idempotencyKey = createStripeRefundIdempotencyKey({
      saleorTransactionId: refundMetadata.saleor_transaction_id,
      stripePaymentIntentId,
      stripeMoney: stripeMoneyResult.value,
      saleorGrantedRefundId,
    });

    const requestStartedAtSeconds = Math.floor(Date.now() / 1000);

    const createRefundResult = await stripeRefundsApi.createRefund({
      paymentIntentId: stripePaymentIntentId,
      stripeMoney: stripeMoneyResult.value,
      metadata: refundMetadata,
      idempotencyKey,
    });

    if (createRefundResult.isErr()) {
      const stripeError = mapStripeErrorToApiError(createRefundResult.error);

      /*
       * A2e (c): no answer that says whether Stripe created the refund (connection error or
       * timeout, Stripe 5xx, the same key still running). Not a REFUND_FAILURE: the refund may
       * exist. HTTP 503 makes Saleor re-send this same request, whose idempotency key returns
       * that refund (RefundOutcomeUnknownResponse). Checked before the idempotency refusal: a
       * 409 "key in use" is not "key reused with other parameters".
       */
      if (isStripeOutcomeUnknown(createRefundResult.error)) {
        this.logger.warn("Stripe refund outcome unknown: asking Saleor to retry the same request", {
          error: stripeError.message,
          stripePaymentIntentId,
        });

        return err(
          new RefundOutcomeUnknownResponse(appContextContainer.getContextValue(), stripeError),
        );
      }

      /*
       * Review round 2 (HIGH): Stripe saw this key with another amount. With the v2 key that
       * is a granted refund whose amount staff edited after a FAILURE, and that failed
       * attempt may have refunded the customer. Refused with a message that says so: a new
       * key here (the old behaviour) refunded twice.
       */
      const error =
        stripeError instanceof StripeIdempotencyError
          ? new RefundRequestChangedError(
              "Stripe refused the refund idempotency key reused with other parameters",
              { cause: stripeError },
            )
          : stripeError;

      this.logger.error("Stripe refund creation failed", {
        error: error.message,
        stripePaymentIntentId,
      });

      return ok(
        new TransactionRefundRequestedUseCaseResponses.Failure({
          transactionResult: new RefundFailureResult(),
          stripePaymentIntentId,
          error,
          appContext: appContextContainer.getContextValue(),
        }),
      );
    }

    const refund = createRefundResult.value;

    /*
     * Stripe answers a key it already saw with the refund it created then. That is the
     * point for a retry, but with the v1 key (no granted refund) it also means a second
     * refund of the same amount on this transaction within 24 h moves no money.
     *
     * Review round 2 (MEDIUM): on that v1 path, when Saleor already recorded the refund as a
     * success, this request is not a retry still waiting for its answer, and reporting it as
     * a refund would show money that never moved: refused. A retry whose refund Saleor has
     * not recorded yet (e.g. the first attempt timed out) still gets the refund Stripe
     * returns. A Saleor on an older subscription sends no events: replays are then only
     * logged, as before. With a granted refund (v2 key) a replay is always a retry of that
     * same granted refund, so it is never refused here: telling staff to "use a granted
     * refund" would invite them to refund the customer twice.
     */
    if (refund.created < requestStartedAtSeconds - REPLAY_DETECTION_MARGIN_SECONDS) {
      const recordedEvents = event.transaction?.events;
      const alreadyRecorded =
        !saleorGrantedRefundId &&
        !!recordedEvents &&
        isRefundRecordedAsSuccess(recordedEvents, refund.id);

      this.logger.warn(
        "Stripe returned an existing refund for this idempotency key: a retry of an earlier request, or (without a granted refund) an identical refund of the same transaction within 24 h (no new money moved)",
        {
          stripeRefundId: refund.id,
          stripePaymentIntentId,
          refundCreatedAt: refund.created,
          amount: refund.amount,
          recordedEventsInPayload: !!recordedEvents,
          alreadyRecordedInSaleor: alreadyRecorded,
        },
      );

      if (alreadyRecorded) {
        return ok(
          new TransactionRefundRequestedUseCaseResponses.Failure({
            transactionResult: new RefundFailureResult(),
            stripePaymentIntentId,
            error: new RefundAlreadyRecordedError(
              `Stripe returned refund ${refund.id}, which Saleor already recorded on the transaction`,
            ),
            appContext: appContextContainer.getContextValue(),
          }),
        );
      }
    }

    const saleorMoneyResult = SaleorMoney.createFromStripe({
      amount: refund.amount,
      currency: refund.currency,
    });

    if (saleorMoneyResult.isErr()) {
      this.logger.error("Failed to convert Stripe refund amount", {
        error: saleorMoneyResult.error.message,
      });

      return err(
        new BrokenAppResponse(appContextContainer.getContextValue(), saleorMoneyResult.error),
      );
    }

    this.logger.info("Stripe refund processed successfully", {
      stripeRefundId: refund.id,
      stripePaymentIntentId: stripePaymentIntentId,
      amount: saleorMoneyResult.value.amount,
    });

    const stripeRefundId = createStripeRefundId(refund.id);

    return ok(
      new TransactionRefundRequestedUseCaseResponses.Success({
        stripeRefundId,
        stripePaymentIntentId: stripePaymentIntentId,
        /*
         * A2e: the Stripe refund id, so each refund has its own pspReference in Saleor. The
         * PaymentIntent only when Stripe returned (idempotency replay) a refund that Saleor
         * recorded under it before A2e: the payload's events (new subscription only) show it.
         */
        pspReference: resolveStripeRefundPspReference({
          stripeRefund: {
            id: stripeRefundId,
            amount: refund.amount,
            currency: refund.currency,
            created: refund.created,
          },
          stripePaymentIntentId,
          recordedEvents: event.transaction?.events ?? [],
        }),
        appContext: appContextContainer.getContextValue(),
      }),
    );
  }
}
