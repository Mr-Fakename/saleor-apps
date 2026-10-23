import { ObservabilityAttributes } from "@saleor/apps-otel/src/observability-attributes";
import { err, ok, Result } from "neverthrow";
import Stripe from "stripe";

import {
  AppIsNotConfiguredResponse,
  BrokenAppResponse,
  MalformedRequestResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import { TransactionCancelationRequestedEventFragment } from "@/generated/graphql";
import { appContextContainer } from "@/lib/app-context";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { loggerContext } from "@/lib/logger-context";
import { AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { resolveSaleorMoneyFromStripePaymentIntent } from "@/modules/saleor/resolve-saleor-money-from-stripe-payment-intent";
import { SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import {
  getChannelIdFromRequestedEventPayload,
  getTransactionFromRequestedEventPayload,
} from "@/modules/saleor/transaction-requested-event-helpers";
import { mapStripeErrorToApiError } from "@/modules/stripe/stripe-api-error";
import { createStripeCancelIdempotencyKey } from "@/modules/stripe/stripe-payment-intent-action-idempotency-key";
import {
  createStripePaymentIntentId,
  StripePaymentIntentId,
} from "@/modules/stripe/stripe-payment-intent-id";
import { isStripeOutcomeUnknown } from "@/modules/stripe/stripe-request-outcome";
import { createTimestampFromPaymentIntent } from "@/modules/stripe/stripe-timestamps";
import { IStripePaymentIntentsApiFactory } from "@/modules/stripe/types";
import {
  CancelFailureResult,
  CancelSuccessResult,
} from "@/modules/transaction-result/cancel-result";

import { CancelAlreadyCapturedError } from "./cancel-refusal-errors";
import {
  CancelOutcomeUnknownResponse,
  TransactionCancelationRequestedUseCaseResponses,
  TransactionCancelationRequestedUseCaseResponsesType,
} from "./use-case-response";

type UseCaseExecuteResult = Result<
  TransactionCancelationRequestedUseCaseResponsesType,
  | AppIsNotConfiguredResponse
  | BrokenAppResponse
  | MalformedRequestResponse
  | CancelOutcomeUnknownResponse
>;

/**
 * TRANSACTION_CANCELATION_REQUESTED: releases an authorization (cancels the PaymentIntent).
 *
 * The live PaymentIntent decides (fixed 2026-10-22). Before, a second cancel (staff retry, the
 * checkout release-funds task, a race) answered Stripe's refusal as CANCEL_FAILURE under the
 * PaymentIntent id, and Saleor 3.22.74 then dropped the earlier CANCEL_SUCCESS
 * (payment/transaction_item_calculations.py _recalculate_cancel_amounts): the released
 * authorization came back in authorizedAmount.
 *
 * - canceled: CANCEL_SUCCESS (a replay, no Stripe write).
 * - succeeded: CANCEL_FAILURE "already captured: refund instead".
 * - processing: HTTP 503, no Stripe write.
 * - otherwise: cancel with idempotency key cancel:v1:<pi>:<status>, one attempt; Stripe decides
 *   (see createStripeCancelIdempotencyKey for why the status is in the key).
 * - A Stripe outcome the app did not get: HTTP 503.
 * Saleor 3.22.74 re-sends a 503 with an EMPTY body, which cannot be processed (see
 * ChargeOutcomeUnknownResponse): nobody retries the cancel for the app. The Stripe webhook
 * (payment_intent.canceled) records a cancel that happened; the A3d capture worker re-reads the
 * PaymentIntent and requests again.
 * - Every CANCEL_FAILURE has a pspReference of its own (createCancelFailurePspReference).
 */
export class TransactionCancelationRequestedUseCase {
  private logger = createLogger("TransactionCancelationRequestedUseCase");
  private appConfigRepo: AppConfigRepo;
  private stripePaymentIntentsApiFactory: IStripePaymentIntentsApiFactory;

  constructor(deps: {
    appConfigRepo: AppConfigRepo;
    stripePaymentIntentsApiFactory: IStripePaymentIntentsApiFactory;
  }) {
    this.appConfigRepo = deps.appConfigRepo;
    this.stripePaymentIntentsApiFactory = deps.stripePaymentIntentsApiFactory;
  }

  /** A Stripe error: 503 when Stripe may have done it, else CANCEL_FAILURE. */
  private stripeErrorResult(args: {
    stripePaymentIntentId: StripePaymentIntentId;
    error: unknown;
    during: "read" | "cancel";
  }): UseCaseExecuteResult {
    const stripeError = mapStripeErrorToApiError(args.error);

    if (isStripeOutcomeUnknown(args.error)) {
      this.logger.warn("Stripe outcome unknown: asking Saleor to retry the same request", {
        during: args.during,
        error: stripeError.message,
        stripePaymentIntentId: args.stripePaymentIntentId,
      });

      return err(
        new CancelOutcomeUnknownResponse(appContextContainer.getContextValue(), stripeError),
      );
    }

    this.logger.error("Stripe refused the request: answering CANCEL_FAILURE", {
      during: args.during,
      error: stripeError.message,
      stripePaymentIntentId: args.stripePaymentIntentId,
    });

    // Nothing changed at Stripe: Saleor keeps the actions it has.
    return ok(
      new TransactionCancelationRequestedUseCaseResponses.Failure({
        stripePaymentIntentId: args.stripePaymentIntentId,
        transactionResult: new CancelFailureResult(),
        error: stripeError,
        actions: null,
        appContext: appContextContainer.getContextValue(),
      }),
    );
  }

  private success(args: {
    stripePaymentIntentId: StripePaymentIntentId;
    paymentIntent: Stripe.PaymentIntent;
  }): UseCaseExecuteResult {
    // canceled: the PaymentIntent amount, as the Stripe webhook reports payment_intent.canceled.
    const saleorMoneyResult = resolveSaleorMoneyFromStripePaymentIntent(args.paymentIntent);

    if (saleorMoneyResult.isErr()) {
      this.logger.error("Failed to create Saleor money", {
        error: saleorMoneyResult.error,
      });

      return err(
        new BrokenAppResponse(appContextContainer.getContextValue(), saleorMoneyResult.error),
      );
    }

    return ok(
      new TransactionCancelationRequestedUseCaseResponses.Success({
        saleorMoney: saleorMoneyResult.value,
        stripePaymentIntentId: args.stripePaymentIntentId,
        transactionResult: new CancelSuccessResult(),
        timestamp: createTimestampFromPaymentIntent(args.paymentIntent),
        appContext: appContextContainer.getContextValue(),
      }),
    );
  }

  async execute(args: {
    appId: string;
    saleorApiUrl: SaleorApiUrl;
    event: TransactionCancelationRequestedEventFragment;
  }): Promise<UseCaseExecuteResult> {
    const { appId, saleorApiUrl, event } = args;

    const transaction = getTransactionFromRequestedEventPayload(event);
    const channelId = getChannelIdFromRequestedEventPayload(event);

    loggerContext.set(ObservabilityAttributes.PSP_REFERENCE, transaction.pspReference);

    const stripeConfigForThisChannel = await this.appConfigRepo.getStripeConfig({
      channelId,
      appId,
      saleorApiUrl,
    });

    if (stripeConfigForThisChannel.isErr()) {
      this.logger.error("Failed to get configuration", {
        error: stripeConfigForThisChannel.error,
      });

      return err(
        new BrokenAppResponse(
          appContextContainer.getContextValue(),
          stripeConfigForThisChannel.error,
        ),
      );
    }

    if (!stripeConfigForThisChannel.value) {
      this.logger.warn("Config for channel not found", {
        channelId,
      });

      return err(
        new AppIsNotConfiguredResponse(
          appContextContainer.getContextValue(),
          new BaseError("No config found for channel"),
        ),
      );
    }

    appContextContainer.set({
      stripeEnv: stripeConfigForThisChannel.value.getStripeEnvValue(),
    });

    const restrictedKey = stripeConfigForThisChannel.value.restrictedKey;

    const stripePaymentIntentsApi = this.stripePaymentIntentsApiFactory.create({
      key: restrictedKey,
    });

    const stripePaymentIntentId = createStripePaymentIntentId(transaction.pspReference);

    const liveResult = await stripePaymentIntentsApi.getPaymentIntentForTransactionAction({
      id: stripePaymentIntentId,
    });

    if (liveResult.isErr()) {
      return this.stripeErrorResult({
        stripePaymentIntentId,
        error: liveResult.error,
        during: "read",
      });
    }

    const live = liveResult.value;

    if (live.status === "canceled") {
      this.logger.info("PaymentIntent already canceled: replaying CANCEL_SUCCESS", {
        stripePaymentIntentId,
      });

      return this.success({ stripePaymentIntentId, paymentIntent: live });
    }

    if (live.status === "succeeded") {
      this.logger.warn("PaymentIntent already captured: answering CANCEL_FAILURE", {
        stripePaymentIntentId,
      });

      return ok(
        new TransactionCancelationRequestedUseCaseResponses.Failure({
          stripePaymentIntentId,
          transactionResult: new CancelFailureResult(),
          error: new CancelAlreadyCapturedError(
            `PaymentIntent ${stripePaymentIntentId} is succeeded`,
          ),
          // Captured money goes back through a refund only.
          actions: ["REFUND"],
          appContext: appContextContainer.getContextValue(),
        }),
      );
    }

    if (live.status === "processing") {
      /*
       * Review P2: Stripe refuses to cancel a processing PaymentIntent in most cases and would
       * store that refusal under the idempotency key. No write: the retry reads it again.
       */
      this.logger.warn("PaymentIntent processing: asking Saleor to retry", {
        stripePaymentIntentId,
      });

      return err(
        new CancelOutcomeUnknownResponse(
          appContextContainer.getContextValue(),
          new BaseError(`PaymentIntent ${stripePaymentIntentId} is processing`),
        ),
      );
    }

    this.logger.info("Canceling Stripe PaymentIntent", {
      stripePaymentIntentId,
      status: live.status,
    });

    const cancelResult = await stripePaymentIntentsApi.cancelPaymentIntentForTransactionAction({
      id: stripePaymentIntentId,
      idempotencyKey: createStripeCancelIdempotencyKey({
        stripePaymentIntentId,
        paymentIntentStatus: live.status,
      }),
    });

    if (cancelResult.isErr()) {
      return this.stripeErrorResult({
        stripePaymentIntentId,
        error: cancelResult.error,
        during: "cancel",
      });
    }

    if (cancelResult.value.status !== "canceled") {
      // Not final: the retry reads the PaymentIntent again.
      this.logger.warn(
        "Cancel answered a PaymentIntent that is not canceled: asking Saleor to retry",
        {
          stripePaymentIntentId,
          status: cancelResult.value.status,
        },
      );

      return err(
        new CancelOutcomeUnknownResponse(
          appContextContainer.getContextValue(),
          new BaseError(
            `PaymentIntent ${stripePaymentIntentId} is ${cancelResult.value.status} after the cancel`,
          ),
        ),
      );
    }

    return this.success({ stripePaymentIntentId, paymentIntent: cancelResult.value });
  }
}
