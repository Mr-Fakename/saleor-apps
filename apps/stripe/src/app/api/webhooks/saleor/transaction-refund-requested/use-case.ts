import { ObservabilityAttributes } from "@saleor/apps-otel/src/observability-attributes";
import { err, ok, Result } from "neverthrow";

import {
  AppIsNotConfiguredResponse,
  BrokenAppResponse,
  MalformedRequestResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import { TransactionRefundRequestedEventFragment } from "@/generated/graphql";
import { appContextContainer } from "@/lib/app-context";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { loggerContext } from "@/lib/logger-context";
import { AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { SaleorMoney } from "@/modules/saleor/saleor-money";
import { createSaleorTransactionId } from "@/modules/saleor/saleor-transaction-id";
import {
  getChannelIdFromRequestedEventPayload,
  getTransactionFromRequestedEventPayload,
} from "@/modules/saleor/transaction-requested-event-helpers";
import { mapStripeErrorToApiError } from "@/modules/stripe/stripe-api-error";
import { StripeMoney } from "@/modules/stripe/stripe-money";
import { createStripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";
import { createStripeRefundId } from "@/modules/stripe/stripe-refund-id";
import { IStripeRefundsApiFactory } from "@/modules/stripe/types";
import { RefundFailureResult } from "@/modules/transaction-result/refund-result";

import {
  TransactionRefundRequestedUseCaseResponses,
  TransactionRefundRequestedUseCaseResponsesType,
} from "./use-case-response";

type UseCaseExecuteResult = Result<
  TransactionRefundRequestedUseCaseResponsesType,
  AppIsNotConfiguredResponse | BrokenAppResponse | MalformedRequestResponse
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
    event: TransactionRefundRequestedEventFragment;
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

    const refundMetadata = {
      saleor_source_id: transaction.checkout?.id ? transaction.checkout.id : transaction.order?.id,
      saleor_source_type: transaction.checkout ? ("Checkout" as const) : ("Order" as const),
      saleor_transaction_id: createSaleorTransactionId(transaction.id),
    };

    const createRefundResult = await stripeRefundsApi.createRefund({
      paymentIntentId: stripePaymentIntentId,
      stripeMoney: stripeMoneyResult.value,
      metadata: refundMetadata,
    });

    if (createRefundResult.isErr()) {
      const error = mapStripeErrorToApiError(createRefundResult.error);

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

    return ok(
      new TransactionRefundRequestedUseCaseResponses.Success({
        stripeRefundId: createStripeRefundId(refund.id),
        stripePaymentIntentId: stripePaymentIntentId,
        appContext: appContextContainer.getContextValue(),
      }),
    );
  }
}
