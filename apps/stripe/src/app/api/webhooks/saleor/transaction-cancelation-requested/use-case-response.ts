import {
  ErrorWebhookResponse,
  SuccessWebhookResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import {
  Actions,
  TransactionCancelationRequestedSyncFailure,
  TransactionCancelationRequestedSyncSuccess,
} from "@/generated/app-webhooks-types/transaction-cancelation-requested";
import { AppContext } from "@/lib/app-context";
import { BaseError } from "@/lib/errors";
import { SaleorMoney } from "@/modules/saleor/saleor-money";
import { createCancelFailurePspReference } from "@/modules/saleor/transaction-action-failure-psp-reference";
import { generatePaymentIntentStripeDashboardUrl } from "@/modules/stripe/generate-stripe-dashboard-urls";
import { StripeApiError } from "@/modules/stripe/stripe-api-error";
import { StripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";
import {
  CancelFailureResult,
  CancelSuccessResult,
} from "@/modules/transaction-result/cancel-result";

import { CancelRefusal } from "./cancel-refusal-errors";

class Success extends SuccessWebhookResponse {
  readonly transactionResult: CancelSuccessResult;
  readonly saleorMoney: SaleorMoney;
  readonly timestamp: Date | null;
  readonly stripePaymentIntentId: StripePaymentIntentId;

  constructor(args: {
    transactionResult: CancelSuccessResult;
    saleorMoney: SaleorMoney;
    timestamp: Date | null;
    stripePaymentIntentId: StripePaymentIntentId;
    appContext: AppContext;
  }) {
    super(args.appContext);
    this.transactionResult = args.transactionResult;
    this.saleorMoney = args.saleorMoney;
    this.timestamp = args.timestamp;
    this.stripePaymentIntentId = args.stripePaymentIntentId;
  }

  getResponse(): Response {
    if (!this.appContext.stripeEnv) {
      throw new BaseError("Stripe environment is not set. Ensure AppContext is set earlier");
    }

    /*
     * Under the PaymentIntent id, with the PaymentIntent amount: the same event the Stripe webhook
     * (payment_intent.canceled) reports, so whichever comes second is a duplicate that Saleor
     * keeps once (payment/utils.py deduplicate_event; transactionEventReport alreadyProcessed).
     */
    const typeSafeResponse: TransactionCancelationRequestedSyncSuccess = {
      result: this.transactionResult.result,
      amount: this.saleorMoney.amount,
      pspReference: this.stripePaymentIntentId,
      message: this.messageFormatter.formatMessage(this.transactionResult.message),
      actions: this.transactionResult.actions,
      externalUrl: generatePaymentIntentStripeDashboardUrl(
        this.stripePaymentIntentId,
        this.appContext.stripeEnv,
      ),
      time: this.timestamp?.toISOString(),
    };

    return Response.json(typeSafeResponse, { status: this.statusCode });
  }
}

class Failure extends SuccessWebhookResponse {
  readonly transactionResult: CancelFailureResult;
  readonly error: StripeApiError | CancelRefusal;
  readonly stripePaymentIntentId: StripePaymentIntentId;
  /**
   * The transaction's available actions after this failure; null leaves Saleor's as they are
   * (Saleor replaces them only when the answer has `actions`, payment/utils.py
   * create_transaction_event_from_request_and_webhook_response).
   */
  readonly actions: Actions;
  /** Unique to this failure: see createCancelFailurePspReference. */
  readonly pspReference: string;

  constructor(args: {
    transactionResult: CancelFailureResult;
    error: StripeApiError | CancelRefusal;
    stripePaymentIntentId: StripePaymentIntentId;
    actions: Actions;
    appContext: AppContext;
  }) {
    super(args.appContext);
    this.transactionResult = args.transactionResult;
    this.error = args.error;
    this.stripePaymentIntentId = args.stripePaymentIntentId;
    this.actions = args.actions;
    this.pspReference = createCancelFailurePspReference();
  }

  getResponse(): Response {
    if (!this.appContext.stripeEnv) {
      throw new BaseError("Stripe environment is not set. Ensure AppContext is set earlier");
    }

    /*
     * Never the PaymentIntent id (live bug fixed 2026-10-22): Saleor drops a CANCEL_SUCCESS when
     * a newer CANCEL_FAILURE has the same pspReference, so a refused second cancel brought the
     * released authorization back. See createCancelFailurePspReference.
     */
    const typeSafeResponse: TransactionCancelationRequestedSyncFailure = {
      result: this.transactionResult.result,
      pspReference: this.pspReference,
      message: this.messageFormatter.formatMessage(this.error.merchantMessage, this.error),
      ...(this.actions !== null && { actions: this.actions }),
      externalUrl: generatePaymentIntentStripeDashboardUrl(
        this.stripePaymentIntentId,
        this.appContext.stripeEnv,
      ),
    };

    return Response.json(typeSafeResponse, { status: this.statusCode });
  }
}

/**
 * Stripe gave no answer that says whether it cancelled (isStripeOutcomeUnknown). HTTP 503: Saleor
 * re-sends the same stored delivery (see ChargeOutcomeUnknownResponse for the Saleor 3.22.74
 * retry rule), and the retry reads the PaymentIntent again: a cancel that happened is then
 * replayed as CANCEL_SUCCESS.
 */
export class CancelOutcomeUnknownResponse extends ErrorWebhookResponse {
  readonly statusCode = 503;
  readonly message = "Stripe cancel outcome unknown, retry the same request";

  getResponse() {
    return Response.json(
      {
        message: this.messageFormatter.formatMessage(this.message, this.error),
      },
      { status: this.statusCode },
    );
  }
}

export const TransactionCancelationRequestedUseCaseResponses = {
  Success,
  Failure,
};

export type TransactionCancelationRequestedUseCaseResponsesType = InstanceType<
  | typeof TransactionCancelationRequestedUseCaseResponses.Success
  | typeof TransactionCancelationRequestedUseCaseResponses.Failure
>;
