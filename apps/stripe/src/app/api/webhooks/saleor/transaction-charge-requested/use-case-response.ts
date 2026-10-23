import {
  ErrorWebhookResponse,
  SuccessWebhookResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import {
  Actions,
  TransactionChargeRequestedSyncFailure,
  TransactionChargeRequestedSyncSuccess,
} from "@/generated/app-webhooks-types/transaction-charge-requested";
import { AppContext } from "@/lib/app-context";
import { BaseError } from "@/lib/errors";
import { createChargeFailurePspReference } from "@/modules/saleor/transaction-action-failure-psp-reference";
import { SaleorMoney } from "@/modules/saleor/saleor-money";
import { generatePaymentIntentStripeDashboardUrl } from "@/modules/stripe/generate-stripe-dashboard-urls";
import { StripeApiError } from "@/modules/stripe/stripe-api-error";
import { StripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";
import { ChargeFailureResult } from "@/modules/transaction-result/failure-result";
import { ChargeSuccessResult } from "@/modules/transaction-result/success-result";

import { ChargeRefusal, getChargeRefusalMerchantMessage } from "./charge-refusal-errors";

class Success extends SuccessWebhookResponse {
  readonly transactionResult: ChargeSuccessResult;
  readonly saleorMoney: SaleorMoney;
  readonly stripePaymentIntentId: StripePaymentIntentId;

  constructor(args: {
    transactionResult: ChargeSuccessResult;
    saleorMoney: SaleorMoney;
    stripePaymentIntentId: StripePaymentIntentId;
    appContext: AppContext;
  }) {
    super(args.appContext);
    this.transactionResult = args.transactionResult;
    this.saleorMoney = args.saleorMoney;
    this.stripePaymentIntentId = args.stripePaymentIntentId;
  }

  getResponse(): Response {
    if (!this.appContext.stripeEnv) {
      throw new BaseError("Stripe environment is not set. Ensure AppContext is set earlier");
    }

    /*
     * Under the PaymentIntent id, with amount_received: the same event the Stripe webhook
     * (payment_intent.succeeded) reports, so whichever comes second is a duplicate that Saleor
     * keeps once (payment/utils.py deduplicate_event; transactionEventReport alreadyProcessed).
     */
    const typeSafeResponse: TransactionChargeRequestedSyncSuccess = {
      result: this.transactionResult.result,
      amount: this.saleorMoney.amount,
      pspReference: this.stripePaymentIntentId,
      message: this.messageFormatter.formatMessage(this.transactionResult.message),
      actions: this.transactionResult.actions,
      externalUrl: generatePaymentIntentStripeDashboardUrl(
        this.stripePaymentIntentId,
        this.appContext.stripeEnv,
      ),
    };

    return Response.json(typeSafeResponse, { status: this.statusCode });
  }
}

class Failure extends SuccessWebhookResponse {
  readonly transactionResult: ChargeFailureResult;
  readonly error: StripeApiError | ChargeRefusal;
  readonly stripePaymentIntentId: StripePaymentIntentId;
  /**
   * The transaction's available actions after this failure; null leaves Saleor's as they are
   * (Saleor replaces them only when the answer has `actions`, payment/utils.py
   * create_transaction_event_from_request_and_webhook_response).
   */
  readonly actions: Actions;
  /** Unique to this failure: see createChargeFailurePspReference. */
  readonly pspReference: string;

  constructor(args: {
    error: StripeApiError | ChargeRefusal;
    transactionResult: ChargeFailureResult;
    stripePaymentIntentId: StripePaymentIntentId;
    actions: Actions;
    appContext: AppContext;
  }) {
    super(args.appContext);
    this.error = args.error;
    this.transactionResult = args.transactionResult;
    this.stripePaymentIntentId = args.stripePaymentIntentId;
    this.actions = args.actions;
    this.pspReference = createChargeFailurePspReference();
  }

  getResponse(): Response {
    if (!this.appContext.stripeEnv) {
      throw new BaseError("Stripe environment is not set. Ensure AppContext is set earlier");
    }

    // A refusal says why; a Stripe error keeps the previous message (details in TEST only).
    const message = getChargeRefusalMerchantMessage(this.error) ?? this.transactionResult.message;

    /*
     * Never the PaymentIntent id (live bug fixed 2026-10-22): Saleor drops a CHARGE_SUCCESS when
     * a newer CHARGE_FAILURE has the same pspReference, so a refused second capture of a captured
     * PaymentIntent took chargedAmount back to 0. See createChargeFailurePspReference.
     */
    const typeSafeResponse: TransactionChargeRequestedSyncFailure = {
      result: this.transactionResult.result,
      pspReference: this.pspReference,
      message: this.messageFormatter.formatMessage(message, this.error),
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
 * Stripe gave no answer that says whether it captured (isStripeOutcomeUnknown), or the
 * PaymentIntent is still processing. A CHARGE_FAILURE would tell staff the capture failed while
 * it may have happened.
 *
 * HTTP 503 instead. Saleor 3.22.74 does re-send a delivery the app answered >= 500
 * (webhook/transport/synchronous/transport.py handle_transaction_request_task,
 * webhook/transport/utils.py handle_webhook_retry), but with an EMPTY body: a failed attempt
 * calls EventPayload.save_as_file(), which writes the empty in-database payload over the stored
 * file (saleor/core/models.py:199-203, webhook/transport/utils.py:651-658; verified
 * 2026-10-23). The retry cannot be processed, so the request ends about 10 s later as Saleor's
 * own CHARGE_FAILURE ("Failed to delivery request.", include_in_calculations=False: it moves no
 * amount). Nothing is captured again by Saleor; the 503 only keeps a false app CHARGE_FAILURE out
 * of the ledger. A capture that did happen is recorded by the Stripe webhook
 * (payment_intent.succeeded), and the A3d capture worker re-reads the PaymentIntent and requests
 * again (PaypalCaptureCoordinator).
 */
export class ChargeOutcomeUnknownResponse extends ErrorWebhookResponse {
  readonly statusCode = 503;
  readonly message = "Stripe capture outcome unknown, retry the same request";

  getResponse() {
    return Response.json(
      {
        message: this.messageFormatter.formatMessage(this.message, this.error),
      },
      { status: this.statusCode },
    );
  }
}

export const TransactionChargeRequestedUseCaseResponses = {
  Success,
  Failure,
};

export type TransactionChargeRequestedUseCaseResponsesType = InstanceType<
  | typeof TransactionChargeRequestedUseCaseResponses.Success
  | typeof TransactionChargeRequestedUseCaseResponses.Failure
>;
