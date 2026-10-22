import {
  ErrorWebhookResponse,
  SuccessWebhookResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import {
  TransactionRefundRequestedAsync,
  TransactionRefundRequestedSyncFailure,
} from "@/generated/app-webhooks-types/transaction-refund-requested";
import { AppContext } from "@/lib/app-context";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { createRefundFailurePspReference } from "@/modules/saleor/refund-psp-reference";
import { generatePaymentIntentStripeDashboardUrl } from "@/modules/stripe/generate-stripe-dashboard-urls";
import { StripeApiError } from "@/modules/stripe/stripe-api-error";
import { StripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";
import { StripeRefundId } from "@/modules/stripe/stripe-refund-id";
import { RefundFailureResult } from "@/modules/transaction-result/refund-result";

import { RefundRefusal } from "./refund-refusal-errors";

const logger = createLogger("TransactionRefundRequestedUseCaseResponse");

class Success extends SuccessWebhookResponse {
  readonly stripeRefundId: StripeRefundId;
  readonly stripePaymentIntentId: StripePaymentIntentId;
  /**
   * What Saleor tracks this refund under: the Stripe refund id, or the PaymentIntent for a
   * refund Saleor recorded under it before A2e (resolveStripeRefundPspReference).
   */
  readonly pspReference: StripeRefundId | StripePaymentIntentId;
  readonly message: string = "";

  constructor(args: {
    stripeRefundId: StripeRefundId;
    stripePaymentIntentId: StripePaymentIntentId;
    pspReference: StripeRefundId | StripePaymentIntentId;
    appContext: AppContext;
  }) {
    super(args.appContext);
    this.stripeRefundId = args.stripeRefundId;
    this.stripePaymentIntentId = args.stripePaymentIntentId;
    this.pspReference = args.pspReference;
  }

  getResponse(): Response {
    /*
     * Async flow: only a pspReference, no result. Saleor copies it onto the REFUND_REQUEST it
     * created for this request (payment/utils.py
     * create_transaction_event_from_request_and_webhook_response), and the REFUND_SUCCESS /
     * REFUND_FAILURE that StripeRefundHandler reports later under the same pspReference closes
     * that request and links it to its granted refund.
     * https://docs.saleor.io/developer/extending/webhooks/synchronous-events/transaction#async-flow-2
     *
     * A2e: the Stripe refund id, not the PaymentIntent. Saleor de-duplicates events by
     * (pspReference, type) and counts one REFUND_SUCCESS per pspReference, so a second refund
     * of the same PaymentIntent was dropped or rejected.
     */
    const typeSafeResponse: TransactionRefundRequestedAsync = {
      pspReference: this.pspReference,
    };

    logger.info("=== SUCCESS RESPONSE DEBUG: Creating success response ===", {
      stripeRefundId: this.stripeRefundId,
      stripePaymentIntentId: this.stripePaymentIntentId,
      statusCode: this.statusCode,
      response: typeSafeResponse,
    });

    return Response.json(typeSafeResponse, { status: this.statusCode });
  }
}

class Failure extends SuccessWebhookResponse {
  readonly transactionResult: RefundFailureResult;
  readonly error: StripeApiError | RefundRefusal;
  readonly stripePaymentIntentId: StripePaymentIntentId;
  readonly message: string;
  /** Unique to this failure: see createRefundFailurePspReference. */
  readonly pspReference: string;

  constructor(args: {
    transactionResult: RefundFailureResult;
    error: StripeApiError | RefundRefusal;
    stripePaymentIntentId: StripePaymentIntentId;
    appContext: AppContext;
  }) {
    super(args.appContext);
    this.transactionResult = args.transactionResult;
    this.error = args.error;
    this.stripePaymentIntentId = args.stripePaymentIntentId;
    this.message = this.error.merchantMessage;
    this.pspReference = createRefundFailurePspReference();
  }

  getResponse(): Response {
    if (!this.appContext.stripeEnv) {
      logger.error("=== FAILURE RESPONSE DEBUG: Stripe environment not set ===", {
        appContext: this.appContext,
      });
      throw new BaseError("Stripe environment is not set. Ensure AppContext is set earlier");
    }

    /*
     * No refund was created (a refusal, or a Stripe error that is not an unknown outcome), so
     * there is no Stripe refund id. Saleor saves this answer with include_in_calculations=True
     * and de-duplicates by (pspReference, type):
     * - Review round 3 (P1): under the PaymentIntent the failure is newer than the
     *   PaymentIntent's earlier REFUND_SUCCESS, which Saleor then drops from refundedAmount
     *   (transaction_item_calculations.py `_should_increse_amount`).
     * - A2e: a retry of the same granted refund replays the same Stripe error (same
     *   idempotency key for 24 h); under a repeated pspReference Saleor merged it into the
     *   earlier failure and the granted refund stayed PENDING. Without a pspReference Saleor
     *   matched its own oldest failure without one and lost this message.
     * A unique pspReference matches nothing: the request gets its own REFUND_FAILURE, counted in
     * no amount, and the granted refund goes to FAILURE (retry allowed).
     */
    const typeSafeResponse: TransactionRefundRequestedSyncFailure = {
      result: this.transactionResult.result,
      pspReference: this.pspReference,
      message: this.messageFormatter.formatMessage(this.message, this.error),
      actions: this.transactionResult.actions,
      externalUrl: generatePaymentIntentStripeDashboardUrl(
        this.stripePaymentIntentId,
        this.appContext.stripeEnv,
      ),
    };

    logger.error("=== FAILURE RESPONSE DEBUG: Creating failure response ===", {
      stripePaymentIntentId: this.stripePaymentIntentId,
      statusCode: this.statusCode,
      error: this.error,
      errorMessage: this.error.message,
      transactionResult: this.transactionResult.result,
      actions: this.transactionResult.actions,
      response: typeSafeResponse,
    });

    return Response.json(typeSafeResponse, { status: this.statusCode });
  }
}

/**
 * Stripe gave no answer that says whether it created the refund (A2e (c), see
 * isStripeOutcomeUnknown). Answering REFUND_FAILURE would tell staff the refund failed while it
 * may exist, and a new granted refund would refund the customer twice.
 *
 * HTTP 503 instead: Saleor 3.22.74 re-sends the same delivery when the app answers >= 500
 * (webhook/transport/synchronous/transport.py `handle_transaction_request_task`: 5 retries,
 * 10 * 2^n s apart, about 5 min), with the same payload, so the refund keeps its idempotency key
 * and Stripe returns the refund it may have made. The granted refund stays PENDING meanwhile.
 * After the last retry Saleor records its own REFUND_FAILURE ("Failed to delivery request.",
 * excluded from amounts) and staff can retry: the same key again for 24 h.
 */
export class RefundOutcomeUnknownResponse extends ErrorWebhookResponse {
  readonly statusCode = 503;
  readonly message = "Stripe refund outcome unknown, retry the same request";

  getResponse() {
    return Response.json(
      {
        message: this.messageFormatter.formatMessage(this.message, this.error),
      },
      { status: this.statusCode },
    );
  }
}

export const TransactionRefundRequestedUseCaseResponses = {
  Success,
  Failure,
};

export type TransactionRefundRequestedUseCaseResponsesType = InstanceType<
  | typeof TransactionRefundRequestedUseCaseResponses.Success
  | typeof TransactionRefundRequestedUseCaseResponses.Failure
>;
