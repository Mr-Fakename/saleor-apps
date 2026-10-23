import { ObservabilityAttributes } from "@saleor/apps-otel/src/observability-attributes";
import { err, ok, Result } from "neverthrow";
import Stripe from "stripe";

import {
  AppIsNotConfiguredResponse,
  BrokenAppResponse,
  MalformedRequestResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import { Actions } from "@/generated/app-webhooks-types/transaction-charge-requested";
import { TransactionChargeRequestedEventFragment } from "@/generated/graphql";
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
import { mapStripeErrorToApiError, StripeApiError } from "@/modules/stripe/stripe-api-error";
import { StripeMoney } from "@/modules/stripe/stripe-money";
import { createStripeCaptureIdempotencyKey } from "@/modules/stripe/stripe-payment-intent-action-idempotency-key";
import {
  createStripePaymentIntentId,
  StripePaymentIntentId,
} from "@/modules/stripe/stripe-payment-intent-id";
import { isStripeOutcomeUnknown } from "@/modules/stripe/stripe-request-outcome";
import { IStripePaymentIntentsApiFactory } from "@/modules/stripe/types";
import { ChargeFailureResult } from "@/modules/transaction-result/failure-result";
import { ChargeSuccessResult } from "@/modules/transaction-result/success-result";

import {
  ChargeAuthorizationReleasedError,
  ChargeNotAuthorizedError,
  ChargeNothingToCaptureError,
  ChargeRefusal,
} from "./charge-refusal-errors";
import {
  ChargeOutcomeUnknownResponse,
  TransactionChargeRequestedUseCaseResponses,
  TransactionChargeRequestedUseCaseResponsesType,
} from "./use-case-response";

type UseCaseExecuteResult = Result<
  TransactionChargeRequestedUseCaseResponsesType,
  | AppIsNotConfiguredResponse
  | BrokenAppResponse
  | MalformedRequestResponse
  | ChargeOutcomeUnknownResponse
>;

/**
 * TRANSACTION_CHARGE_REQUESTED: captures an authorized PaymentIntent.
 *
 * The live PaymentIntent decides (fixed 2026-10-22). Before, the handler captured the whole
 * authorization whatever amount Saleor asked for, and answered any Stripe error as CHARGE_FAILURE
 * under the PaymentIntent id. Saleor 3.22.74 drops a CHARGE_SUCCESS when a newer CHARGE_FAILURE
 * has the same pspReference (payment/transaction_item_calculations.py _should_increse_amount),
 * so a second capture request on a captured PaymentIntent (double click, an app/staff race, a
 * retry) took chargedAmount back to 0.
 *
 * - succeeded: CHARGE_SUCCESS with amount_received (a replay, no Stripe write).
 * - canceled: CHARGE_FAILURE "authorization released or expired", actions CANCEL.
 * - requires_capture: capture min(requested, amount_capturable), idempotency key
 *   capture:v1:<pi>:<amount>, one attempt.
 * - processing, or a Stripe outcome the app did not get: HTTP 503 (ChargeOutcomeUnknownResponse).
 *   Saleor 3.22.74 re-sends it with an EMPTY body, which cannot be processed: nobody retries the
 *   capture for the app. The Stripe webhook records a capture that happened; the A3d capture
 *   worker re-reads the PaymentIntent and requests again (PaypalCaptureCoordinator).
 * - Every CHARGE_FAILURE has a pspReference of its own (createChargeFailurePspReference).
 */
export class TransactionChargeRequestedUseCase {
  private logger = createLogger("TransactionChargeRequestedUseCase");
  private appConfigRepo: AppConfigRepo;
  private stripePaymentIntentsApiFactory: IStripePaymentIntentsApiFactory;

  constructor(deps: {
    appConfigRepo: AppConfigRepo;
    stripePaymentIntentsApiFactory: IStripePaymentIntentsApiFactory;
  }) {
    this.appConfigRepo = deps.appConfigRepo;
    this.stripePaymentIntentsApiFactory = deps.stripePaymentIntentsApiFactory;
  }

  private failure(args: {
    stripePaymentIntentId: StripePaymentIntentId;
    error: StripeApiError | ChargeRefusal;
    actions: Actions;
  }) {
    return ok(
      new TransactionChargeRequestedUseCaseResponses.Failure({
        transactionResult: new ChargeFailureResult(),
        stripePaymentIntentId: args.stripePaymentIntentId,
        error: args.error,
        actions: args.actions,
        appContext: appContextContainer.getContextValue(),
      }),
    );
  }

  /** A Stripe error: 503 when Stripe may have done it, else CHARGE_FAILURE. */
  private stripeErrorResult(args: {
    stripePaymentIntentId: StripePaymentIntentId;
    error: unknown;
    during: "read" | "capture";
  }): UseCaseExecuteResult {
    const stripeError = mapStripeErrorToApiError(args.error);

    if (isStripeOutcomeUnknown(args.error)) {
      this.logger.warn("Stripe outcome unknown: asking Saleor to retry the same request", {
        during: args.during,
        error: stripeError.message,
        stripePaymentIntentId: args.stripePaymentIntentId,
      });

      return err(
        new ChargeOutcomeUnknownResponse(appContextContainer.getContextValue(), stripeError),
      );
    }

    this.logger.error("Stripe refused the request: answering CHARGE_FAILURE", {
      during: args.during,
      error: stripeError.message,
      stripePaymentIntentId: args.stripePaymentIntentId,
    });

    // Nothing changed at Stripe: Saleor keeps the actions it has (e.g. CHARGE and CANCEL).
    return this.failure({
      stripePaymentIntentId: args.stripePaymentIntentId,
      error: stripeError,
      actions: null,
    });
  }

  private success(args: {
    stripePaymentIntentId: StripePaymentIntentId;
    paymentIntent: Stripe.PaymentIntent;
  }): UseCaseExecuteResult {
    // succeeded: amount_received.
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
      new TransactionChargeRequestedUseCaseResponses.Success({
        transactionResult: new ChargeSuccessResult(),
        stripePaymentIntentId: args.stripePaymentIntentId,
        saleorMoney: saleorMoneyResult.value,
        appContext: appContextContainer.getContextValue(),
      }),
    );
  }

  async execute(args: {
    appId: string;
    saleorApiUrl: SaleorApiUrl;
    event: TransactionChargeRequestedEventFragment;
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
          new BaseError("Config for channel not found"),
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

    switch (live.status) {
      case "succeeded":
        this.logger.info("PaymentIntent already captured: replaying CHARGE_SUCCESS", {
          stripePaymentIntentId,
          amountReceived: live.amount_received,
        });

        return this.success({ stripePaymentIntentId, paymentIntent: live });

      case "canceled":
        this.logger.warn("PaymentIntent canceled: nothing to capture", { stripePaymentIntentId });

        return this.failure({
          stripePaymentIntentId,
          error: new ChargeAuthorizationReleasedError(
            `PaymentIntent ${stripePaymentIntentId} is canceled`,
          ),
          /*
           * Review P2: CANCEL only. Nothing can be charged or refunded, but Saleor still counts
           * the authorization; staff keep the Dashboard's Cancel, and the cancel handler then
           * replays CANCEL_SUCCESS, which takes it out of authorizedAmount.
           */
          actions: ["CANCEL"],
        });

      case "processing":
        this.logger.warn("PaymentIntent processing: asking Saleor to retry", {
          stripePaymentIntentId,
        });

        return err(
          new ChargeOutcomeUnknownResponse(
            appContextContainer.getContextValue(),
            new BaseError(`PaymentIntent ${stripePaymentIntentId} is processing`),
          ),
        );

      case "requires_capture":
        break;

      default:
        this.logger.warn("PaymentIntent holds no authorization: nothing to capture", {
          stripePaymentIntentId,
          status: live.status,
        });

        return this.failure({
          stripePaymentIntentId,
          error: new ChargeNotAuthorizedError(
            `PaymentIntent ${stripePaymentIntentId} is ${live.status}`,
          ),
          actions: null,
        });
    }

    /*
     * The PaymentIntent's currency: the transaction was created in it (transaction-initialize
     * creates the PaymentIntent in the action's currency), and the subscription does not send
     * the action's currency.
     */
    const requestedResult = StripeMoney.createFromSaleorAmount({
      amount: event.action.amount,
      currency: live.currency,
    });

    if (requestedResult.isErr()) {
      this.logger.error("Invalid capture amount or currency", {
        error: requestedResult.error.message,
        amount: event.action.amount,
        currency: live.currency,
      });

      return err(
        new MalformedRequestResponse(appContextContainer.getContextValue(), requestedResult.error),
      );
    }

    const amountToCapture = Math.min(requestedResult.value.amount, live.amount_capturable);

    if (amountToCapture <= 0) {
      this.logger.warn("Nothing to capture", {
        stripePaymentIntentId,
        requestedAmount: event.action.amount,
        amountCapturable: live.amount_capturable,
      });

      return this.failure({
        stripePaymentIntentId,
        error: new ChargeNothingToCaptureError("The requested capture amount is 0"),
        actions: null,
      });
    }

    this.logger.info("Capturing Stripe PaymentIntent", {
      stripePaymentIntentId,
      amountToCapture,
      amountCapturable: live.amount_capturable,
    });

    const captureResult = await stripePaymentIntentsApi.capturePaymentIntent({
      id: stripePaymentIntentId,
      amountToCapture,
      idempotencyKey: createStripeCaptureIdempotencyKey({
        stripePaymentIntentId,
        amountToCapture,
      }),
    });

    if (captureResult.isErr()) {
      return this.stripeErrorResult({
        stripePaymentIntentId,
        error: captureResult.error,
        during: "capture",
      });
    }

    if (captureResult.value.status !== "succeeded") {
      // Not final yet: the retry reads the PaymentIntent again.
      this.logger.warn(
        "Capture answered a PaymentIntent that is not succeeded: asking Saleor to retry",
        {
          stripePaymentIntentId,
          status: captureResult.value.status,
        },
      );

      return err(
        new ChargeOutcomeUnknownResponse(
          appContextContainer.getContextValue(),
          new BaseError(
            `PaymentIntent ${stripePaymentIntentId} is ${captureResult.value.status} after the capture`,
          ),
        ),
      );
    }

    /*
     * Partial capture: Stripe releases the rest of the authorization, but Saleor 3.22.74 keeps it
     * in authorizedAmount (it subtracts only the CHARGE_SUCCESS amount,
     * payment/transaction_item_calculations.py _recalculate_charge_amounts) until a
     * CANCEL_SUCCESS reports it. A sync answer carries one CHARGE_* event only
     * (webhook/response_schemas/transaction.py), so the remainder is not reported here. The
     * answer's actions (REFUND) leave nothing to capture or cancel on the transaction.
     */
    return this.success({ stripePaymentIntentId, paymentIntent: captureResult.value });
  }
}
