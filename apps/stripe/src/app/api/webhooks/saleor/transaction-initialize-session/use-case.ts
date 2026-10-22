import { APL, AuthData } from "@saleor/app-sdk/APL";
import { ObservabilityAttributes } from "@saleor/apps-otel/src/observability-attributes";
import { captureException } from "@sentry/nextjs";
import { err, fromThrowable, ok, Result } from "neverthrow";
import Stripe from "stripe";

import {
  AppIsNotConfiguredResponse,
  BrokenAppResponse,
  MalformedRequestResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import {
  TransactionInitializeSessionEventFragment,
  TransactionUpdateDocument,
} from "@/generated/graphql";
import { appContextContainer } from "@/lib/app-context";
import { BaseError } from "@/lib/errors";
import { createInstrumentedGraphqlClient } from "@/lib/graphql-client";
import { createLogger } from "@/lib/logger";
import { loggerContext } from "@/lib/logger-context";
import { mapWithConcurrency } from "@/lib/map-with-concurrency";
import { saleorApp } from "@/lib/saleor-app";
import { AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { ResolvedTransactionFlow } from "@/modules/resolved-transaction-flow";
import {
  CheckoutAmountDueErrors,
  resolveCheckoutAmountDue,
} from "@/modules/saleor/checkout-amount-due";
import { checkoutLogRef } from "@/modules/saleor/checkout-log-ref";
import {
  CheckoutPaymentStateTransaction,
  ICheckoutPaymentStateFetcher,
} from "@/modules/saleor/checkout-payment-state-fetcher";
import { hasRecordedMoneyMovement } from "@/modules/saleor/recorded-money-movement";
import { SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { SaleorMoney } from "@/modules/saleor/saleor-money";
import {
  createSaleorTransactionFlow,
  SaleorTransationFlow,
} from "@/modules/saleor/saleor-transaction-flow";
import { createSaleorTransactionId } from "@/modules/saleor/saleor-transaction-id";
import { mapStripeErrorToApiError } from "@/modules/stripe/stripe-api-error";
import {
  createStripeClientSecret,
  StripeClientSecret,
  StripeClientSecretValidationError,
} from "@/modules/stripe/stripe-client-secret";
import { StripeMoney } from "@/modules/stripe/stripe-money";
import {
  createStripePaymentIntentId,
  StripePaymentIntentId,
  StripePaymentIntentValidationError,
} from "@/modules/stripe/stripe-payment-intent-id";
import {
  createStripePaymentIntentStatus,
  isPaymentIntentAmountUpdatable,
  isPaymentIntentMoneyMoving,
  StripePaymentIntentStatus,
} from "@/modules/stripe/stripe-payment-intent-status";
import {
  CreatePaymentIntentArgs,
  IStripePaymentIntentsApi,
  IStripePaymentIntentsApiFactory,
} from "@/modules/stripe/types";
import {
  AuthorizationActionRequiredResult,
  ChargeActionRequiredResult,
} from "@/modules/transaction-result/action-required-result";
import {
  AuthorizationFailureResult,
  ChargeFailureResult,
} from "@/modules/transaction-result/failure-result";
import { RecordedTransaction } from "@/modules/transactions-recording/domain/recorded-transaction";
import { TransactionRecorderRepo } from "@/modules/transactions-recording/repositories/transaction-recorder-repo";

import {
  parseTransactionInitializeSessionEventData,
  TransactionInitializeSessionEventData,
} from "./event-data-parser";
import {
  CheckoutNotFoundError,
  CurrencyMismatchError,
  NothingDueError,
  OtherPaymentsUnverifiedError,
  PaymentAmountRefusal,
  PaymentInFlightError,
  PaymentPendingError,
} from "./payment-amount-errors";
import { resolvePaymentMethodFromEventData } from "./payment-method-resolver";
import {
  TransactionInitializeSessionUseCaseResponses,
  TransactionInitializeSessionUseCaseResponsesType,
} from "./use-case-response";

type UseCaseExecuteResult = Result<
  TransactionInitializeSessionUseCaseResponsesType,
  AppIsNotConfiguredResponse | BrokenAppResponse | MalformedRequestResponse
>;

/**
 * The amount this transaction may charge, decided before any Stripe write (NR-31).
 * `checkoutTransactions` is null for an Order source, whose amount is not verified.
 */
type ChargeAmount = {
  stripeMoney: StripeMoney;
  checkoutTransactions: ReadonlyArray<CheckoutPaymentStateTransaction> | null;
};

type ChargeAmountRefusal = MalformedRequestResponse | BrokenAppResponse | PaymentAmountRefusal;

type StorefrontPaymentIntentOutcome =
  | { outcome: "updated"; paymentIntent: Stripe.PaymentIntent }
  | { outcome: "not-usable" }
  | { outcome: "refused"; error: PaymentAmountRefusal };

/**
 * What became of one PaymentIntent of the checkout that the app will not hand out:
 * - closed: canceled now or before, it can never be paid;
 * - recorded: money moving or taken and recorded in Saleor (already counted in the amount
 *   due), left alone;
 * - not-ours: unknown to this Stripe account, or created for another source; left alone;
 * - payment-in-flight: money moving or taken and NOT recorded in Saleor yet;
 * - unverified: could be neither read nor cancelled.
 */
type ClosePaymentIntentOutcome =
  | "closed"
  | "recorded"
  | "not-ours"
  | "payment-in-flight"
  | "unverified";

/**
 * What to do with the exact-amount PaymentIntent the Stripe search found, judged on its live
 * state (review round 2, Q4).
 */
type FoundPaymentIntentDecision =
  | { decision: "hand-out"; paymentIntent: Stripe.PaymentIntent }
  | { decision: "update"; paymentIntent: Stripe.PaymentIntent }
  | { decision: "create" }
  | { decision: "refused"; error: PaymentAmountRefusal };

/**
 * At most this many PaymentIntents are checked or cancelled at the same time (review round 2,
 * Q6): a checkout with many abandoned attempts must not burst Stripe's rate limit.
 */
const MAX_CONCURRENT_PAYMENT_INTENT_CLOSES = 5;

const isStripeResourceMissing = (error: unknown): boolean =>
  error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_missing";

export class TransactionInitializeSessionUseCase {
  private logger = createLogger("TransactionInitializeSessionUseCase");
  private appConfigRepo: AppConfigRepo;
  private stripePaymentIntentsApiFactory: IStripePaymentIntentsApiFactory;
  private transactionRecorder: TransactionRecorderRepo;
  private apl: Pick<APL, "get">;
  private checkoutPaymentStateFetcherFactory: (authData: AuthData) => ICheckoutPaymentStateFetcher;

  constructor(deps: {
    appConfigRepo: AppConfigRepo;
    stripePaymentIntentsApiFactory: IStripePaymentIntentsApiFactory;
    transactionRecorder: TransactionRecorderRepo;
    apl: Pick<APL, "get">;
    checkoutPaymentStateFetcherFactory: (authData: AuthData) => ICheckoutPaymentStateFetcher;
  }) {
    this.appConfigRepo = deps.appConfigRepo;
    this.stripePaymentIntentsApiFactory = deps.stripePaymentIntentsApiFactory;
    this.transactionRecorder = deps.transactionRecorder;
    this.apl = deps.apl;
    this.checkoutPaymentStateFetcherFactory = deps.checkoutPaymentStateFetcherFactory;
  }

  private prepareStripeCreatePaymentIntentParams(args: {
    event: TransactionInitializeSessionEventFragment;
    eventData: TransactionInitializeSessionEventData;
    stripeMoney: StripeMoney;
    selectedPaymentMethodOptions: Stripe.PaymentIntentCreateParams.PaymentMethodOptions;
    idempotencyKey: string;
  }): CreatePaymentIntentArgs {
    return {
      metadata: {
        saleor_source_id: args.event.sourceObject.id,
        saleor_source_type: args.event.sourceObject.__typename,
        saleor_transaction_id: createSaleorTransactionId(args.event.transaction.id),
      },
      stripeMoney: args.stripeMoney,
      idempotencyKey: args.idempotencyKey,
      intentParams: {
        /*
         * Enable all payment methods configured in the Stripe Dashboard.
         * The app validated if it allow payment method before.
         */
        automatic_payment_methods: {
          enabled: true,
        },
        payment_method_options: {
          ...args.selectedPaymentMethodOptions,
        },
      },
    };
  }

  private mapStripePaymentIntentToWebhookResponse(
    paymentIntent: Stripe.PaymentIntent,
  ): Result<
    [SaleorMoney, StripePaymentIntentId, StripeClientSecret, StripePaymentIntentStatus],
    InstanceType<
      | typeof StripePaymentIntentValidationError
      | typeof SaleorMoney.ValidationError
      | typeof StripeClientSecretValidationError
    >
  > {
    return Result.combine([
      /*
       * The response amount is the amount the PaymentIntent will charge, which this use
       * case set to the amount owed (NR-31). Saleor stores it on the transaction event
       * (saleor/payment/utils.py `parse_transaction_action_data_for_session_webhook`:
       * `amount=response.amount or request_amount`). Not derived from the status: for a
       * requires_confirmation intent `amount_received` is still 0, and Saleor would then
       * fall back to the caller's amount.
       */
      SaleorMoney.createFromStripe({
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
      }),
      fromThrowable(createStripePaymentIntentId)(paymentIntent.id),
      createStripeClientSecret(paymentIntent.client_secret),
      fromThrowable(createStripePaymentIntentStatus)(paymentIntent.status),
    ]);
  }

  private resolveErrorTransactionResult(
    transactionFlow: ResolvedTransactionFlow | SaleorTransationFlow,
  ): ChargeFailureResult | AuthorizationFailureResult {
    if (transactionFlow === "AUTHORIZATION") {
      return new AuthorizationFailureResult();
    }

    return new ChargeFailureResult();
  }

  private resolveOkTransactionResult({
    transactionFlow,
    stripeStatus,
  }: {
    transactionFlow: ResolvedTransactionFlow;
    stripeStatus: StripePaymentIntentStatus;
  }): ChargeActionRequiredResult | AuthorizationActionRequiredResult {
    if (transactionFlow === "AUTHORIZATION") {
      return new AuthorizationActionRequiredResult(stripeStatus);
    }

    return new ChargeActionRequiredResult(stripeStatus);
  }

  private refusedResponse(
    error: PaymentAmountRefusal,
    transactionFlow: ResolvedTransactionFlow,
  ): InstanceType<typeof TransactionInitializeSessionUseCaseResponses.Failure> {
    return new TransactionInitializeSessionUseCaseResponses.Failure({
      transactionResult: this.resolveErrorTransactionResult(transactionFlow),
      error,
      appContext: appContextContainer.getContextValue(),
    });
  }

  /**
   * Decides what this transaction charges (regression NR-31). Saleor forwards the caller's
   * `transactionInitialize(amount:)` unchanged (saleor/graphql/payment/mutations/base.py
   * `TransactionSessionBase.get_amount`), and without `amount:` it uses the total BEFORE gift
   * cards. So for a checkout the amount is always recomputed from Saleor with the app token:
   *
   *   checkout.totalPrice.gross - Σ (charged + authorized) of the checkout's transactions
   *
   * The transaction being initialized is in that list: Saleor commits it, empty, before it
   * calls this webhook, so the sum is what the OTHER transactions hold. If it already holds
   * money (a replayed idempotency key), that money is owed too.
   *
   * Order sources keep the requested amount: neither storefront initializes a transaction on
   * an order (only `transactionInitialize(id: $checkoutId)` exists), so the path is not used
   * by dess/SDS. It is reachable through the public API by anyone holding an order ID; it is
   * logged so any use shows up.
   *
   * No Stripe write happens before the amount is known. The only Stripe calls here are on the
   * PaymentPending and NothingDue refusals, which first close the checkout's other payable
   * PaymentIntents (review round 2).
   */
  private async resolveChargeAmount(args: {
    event: TransactionInitializeSessionEventFragment;
    saleorApiUrl: SaleorApiUrl;
    stripePaymentIntentsApi: IStripePaymentIntentsApi;
  }): Promise<Result<ChargeAmount, ChargeAmountRefusal>> {
    const { event, saleorApiUrl, stripePaymentIntentsApi } = args;

    const requestedResult = StripeMoney.createFromSaleorAmount({
      amount: event.action.amount,
      currency: event.action.currency,
    });

    if (requestedResult.isErr()) {
      captureException(requestedResult.error);

      return err(
        new MalformedRequestResponse(appContextContainer.getContextValue(), requestedResult.error),
      );
    }

    const requested = requestedResult.value;

    if (event.sourceObject.__typename === "Order") {
      this.logger.warn(
        "transactionInitialize on an Order: charging the requested amount, which is not checked against Saleor",
        { requestedAmount: requested.amount, currency: requested.currency },
      );

      return ok({ stripeMoney: requested, checkoutTransactions: null });
    }

    const checkoutId = event.sourceObject.id;
    const checkoutRef = checkoutLogRef(checkoutId);

    const authData = await this.apl.get(saleorApiUrl);

    if (!authData) {
      this.logger.error("No auth data found for saleorApiUrl; cannot verify the checkout amount", {
        saleorApiUrl,
      });

      return err(
        new BrokenAppResponse(
          appContextContainer.getContextValue(),
          new BaseError("No authentication data found"),
        ),
      );
    }

    const checkoutResult = await this.checkoutPaymentStateFetcherFactory(
      authData,
    ).fetchCheckoutPaymentState({ checkoutId });

    if (checkoutResult.isErr()) {
      this.logger.error(
        "Failed to read the checkout from Saleor; not charging an unverified amount",
        {
          checkoutRef,
          error: checkoutResult.error,
        },
      );

      return err(
        new BrokenAppResponse(appContextContainer.getContextValue(), checkoutResult.error),
      );
    }

    const checkout = checkoutResult.value;

    if (!checkout) {
      this.logger.warn("Saleor did not return the checkout; refusing the payment", { checkoutRef });

      return err(new CheckoutNotFoundError(`Checkout ${checkoutRef} not found`));
    }

    const dueResult = resolveCheckoutAmountDue({ checkout, currency: requested.currency });

    if (dueResult.isErr()) {
      const refusal = dueResult.error;

      this.logger.warn("Refusing to start a payment for the checkout", {
        checkoutRef,
        reason: refusal.name,
        requestedAmount: requested.amount,
        currency: requested.currency,
        checkoutTotal: checkout.totalPrice.gross.amount,
        checkoutCurrency: checkout.totalPrice.gross.currency,
      });

      if (
        refusal instanceof CheckoutAmountDueErrors.CurrencyMismatchError ||
        refusal instanceof CheckoutAmountDueErrors.ForeignCurrencyHeldError
      ) {
        return err(new CurrencyMismatchError(refusal.message, { cause: refusal }));
      }

      /*
       * Review round 2 (MEDIUM): the checkout is paid, or a payment of it is pending. A
       * PaymentIntent another tab still holds would charge it again: close every payable one
       * listed on the checkout before refusing. Recorded payments and unrecorded ones in
       * flight are left alone (closePaymentIntent never cancels money that moves). The
       * refusal stands whatever the outcome.
       */
      if (
        refusal instanceof CheckoutAmountDueErrors.PaymentPendingError ||
        refusal instanceof CheckoutAmountDueErrors.NothingDueError
      ) {
        await this.closeOtherPaymentIntents({
          stripePaymentIntentsApi,
          keep: null,
          searchResults: [],
          event,
          checkoutTransactions: checkout.transactions ?? [],
        });
      }

      if (refusal instanceof CheckoutAmountDueErrors.PaymentPendingError) {
        return err(new PaymentPendingError(refusal.message, { cause: refusal }));
      }

      if (refusal instanceof CheckoutAmountDueErrors.NothingDueError) {
        return err(new NothingDueError(refusal.message, { cause: refusal }));
      }

      return err(new BrokenAppResponse(appContextContainer.getContextValue(), refusal));
    }

    const due = dueResult.value;

    if (requested.amount !== due.stripeMoney.amount) {
      this.logger.warn(
        "transactionInitialize amount differs from what the checkout owes; charging the checkout balance",
        {
          checkoutRef,
          requestedAmount: requested.amount,
          amountDue: due.stripeMoney.amount,
          checkoutTotal: due.checkoutTotal.amount,
          currency: due.stripeMoney.currency,
          heldByOtherTransactions: due.heldByCountedTransactions,
        },
      );
    }

    return ok({ stripeMoney: due.stripeMoney, checkoutTransactions: checkout.transactions ?? [] });
  }

  private belongsToSource(
    paymentIntent: Stripe.PaymentIntent,
    sourceObject: TransactionInitializeSessionEventFragment["sourceObject"],
  ): boolean {
    return (
      paymentIntent.metadata?.saleor_source_id === sourceObject.id &&
      paymentIntent.metadata?.saleor_source_type === sourceObject.__typename
    );
  }

  /**
   * True when the PaymentIntent's money is moving or taken (processing, requires_capture,
   * succeeded) but no transaction of the checkout records it yet - typically the seconds
   * between a confirmation in the browser and the Stripe webhook reaching Saleor. Starting
   * another payment then could charge the shopper twice.
   *
   * Recorded means a transaction linked to the PaymentIntent (by pspReference, or by the
   * PaymentIntent's `saleor_transaction_id`) shows ANY money movement, including money that
   * went back: a fully refunded or charged-back payment holds nothing, but it is recorded,
   * and treating it as in flight blocked the checkout forever (review M2). Recorded money is
   * safe: resolveChargeAmount already subtracted what it still holds (or refused while it is
   * pending). Order sources (no checkout state) keep their previous behaviour.
   */
  private isUnrecordedPaymentInFlight(
    paymentIntent: Stripe.PaymentIntent,
    checkoutTransactions: ChargeAmount["checkoutTransactions"],
  ): boolean {
    if (!checkoutTransactions || !isPaymentIntentMoneyMoving(paymentIntent.status)) {
      return false;
    }

    const linkedTransactionId = paymentIntent.metadata?.saleor_transaction_id;

    const recorded = checkoutTransactions.some(
      (t) =>
        (t.pspReference === paymentIntent.id ||
          (!!linkedTransactionId && t.id === linkedTransactionId)) &&
        hasRecordedMoneyMovement(t),
    );

    return !recorded;
  }

  /**
   * The storefront may name the PaymentIntent it already mounted (`existingPaymentIntentId`).
   * It is honoured only when the app created it for this checkout/order (metadata
   * `saleor_source_id` + `saleor_source_type`) and its status still accepts an amount
   * (same allowlist as /api/update-payment-intent). A PaymentIntent of another source is
   * never read further or modified: the app falls back to its own search/create, so a stale
   * id from an old session cannot block a legitimate payment.
   *
   * Before it is updated and handed out, the checkout's other PaymentIntents are closed
   * (review M1, closeOthersBeforeHandOut). This path needs no Stripe search: every
   * PaymentIntent a shopper can pay is listed on the checkout's Saleor transactions.
   */
  private async tryStorefrontPaymentIntent(args: {
    stripePaymentIntentsApi: IStripePaymentIntentsApi;
    existingPaymentIntentId: string;
    event: TransactionInitializeSessionEventFragment;
    stripeMoney: StripeMoney;
    checkoutTransactions: ChargeAmount["checkoutTransactions"];
  }): Promise<StorefrontPaymentIntentOutcome> {
    const { stripePaymentIntentsApi, event, stripeMoney, checkoutTransactions } = args;
    const paymentIntentId = createStripePaymentIntentId(args.existingPaymentIntentId);

    const retrieved = await stripePaymentIntentsApi.getPaymentIntent({ id: paymentIntentId });

    if (retrieved.isErr()) {
      this.logger.warn(
        "Could not retrieve the PaymentIntent named by the storefront; ignoring it",
        {
          paymentIntentId,
          error: mapStripeErrorToApiError(retrieved.error),
        },
      );

      return { outcome: "not-usable" };
    }

    const paymentIntent = retrieved.value;

    if (!this.belongsToSource(paymentIntent, event.sourceObject)) {
      this.logger.warn(
        "Storefront named a PaymentIntent that was not created for this source; leaving it untouched",
        { paymentIntentId },
      );

      return { outcome: "not-usable" };
    }

    if (this.isUnrecordedPaymentInFlight(paymentIntent, checkoutTransactions)) {
      this.logger.warn(
        "The storefront's PaymentIntent is already being paid; not starting another",
        {
          paymentIntentId,
          status: paymentIntent.status,
        },
      );

      return this.refuseWhilePaymentInFlight({
        stripePaymentIntentsApi,
        inFlightPaymentIntentId: paymentIntentId,
        event,
        checkoutTransactions,
        message: "The storefront's PaymentIntent is already being paid",
      });
    }

    if (
      !isPaymentIntentAmountUpdatable(paymentIntent.status) ||
      paymentIntent.currency !== stripeMoney.currency
    ) {
      this.logger.info("The storefront's PaymentIntent cannot take the amount; using another one", {
        paymentIntentId,
        status: paymentIntent.status,
      });

      return { outcome: "not-usable" };
    }

    // Review M1: no other PaymentIntent of the checkout may stay payable next to this one.
    const handOutAllowed = await this.closeOthersBeforeHandOut({
      stripePaymentIntentsApi,
      keep: paymentIntentId,
      searchResults: [],
      event,
      checkoutTransactions,
    });

    if (handOutAllowed.isErr()) {
      return { outcome: "refused", error: handOutAllowed.error };
    }

    const updateResult = await stripePaymentIntentsApi.updatePaymentIntent({
      id: paymentIntentId,
      stripeMoney,
      metadata: {
        saleor_transaction_id: createSaleorTransactionId(event.transaction.id),
      },
      idempotencyKey: `update_direct_${event.idempotencyKey}`,
    });

    if (updateResult.isOk()) {
      return { outcome: "updated", paymentIntent: updateResult.value };
    }

    this.logger.warn("Failed to update the storefront's PaymentIntent, will search/create", {
      paymentIntentId,
      error: updateResult.error,
    });

    // Stripe refuses an amount update once money moves; look again before starting another payment.
    const live = await stripePaymentIntentsApi.getPaymentIntent({ id: paymentIntentId });

    if (live.isOk() && this.isUnrecordedPaymentInFlight(live.value, checkoutTransactions)) {
      // The checkout's other PaymentIntents were closed above.
      return {
        outcome: "refused",
        error: new PaymentInFlightError("The storefront's PaymentIntent is already being paid"),
      };
    }

    return { outcome: "not-usable" };
  }

  /**
   * The PaymentIntents of the checkout other than `keep` (review M1):
   * - every `pi_` pspReference on the checkout's Saleor transactions. Saleor writes the
   *   pspReference of a transactionInitialize response on its transaction before the
   *   storefront gets the client secret, so every PaymentIntent a shopper can pay is listed
   *   here, whatever its status, as of the checkout read at the start of this request;
   * - the PaymentIntents the Stripe search returned. The search only lists
   *   requires_payment_method intents and lags behind Stripe by up to about a minute.
   *
   * Skipped (review round 2, Q6): a PaymentIntent whose Saleor transaction shows
   * CANCEL_SUCCESS. The app reports it only once Stripe canceled the PaymentIntent (Stripe's
   * payment_intent.canceled event, or a successful cancel request), and a canceled
   * PaymentIntent can never be paid, so reading it again is a wasted Stripe call.
   */
  private otherPaymentIntentIds(args: {
    keep: StripePaymentIntentId | null;
    searchResults: ReadonlyArray<Stripe.PaymentIntent>;
    checkoutTransactions: ChargeAmount["checkoutTransactions"];
  }): string[] {
    const checkoutTransactions = args.checkoutTransactions ?? [];

    const ids = new Set<string>([
      ...checkoutTransactions
        .map((t) => t.pspReference)
        .filter((pspReference) => pspReference.startsWith("pi_")),
      ...args.searchResults.map((pi) => pi.id),
    ]);

    if (args.keep) {
      ids.delete(args.keep);
    }

    for (const transaction of checkoutTransactions) {
      if (
        ids.has(transaction.pspReference) &&
        transaction.events.some((event) => event.type === "CANCEL_SUCCESS")
      ) {
        this.logger.debug("Skipping a PaymentIntent that Saleor recorded as canceled", {
          paymentIntentId: transaction.pspReference,
        });
        ids.delete(transaction.pspReference);
      }
    }

    return [...ids];
  }

  /**
   * For a PaymentIntent that needs no cancel: its outcome. Null while it can still be paid.
   */
  private settledOutcome(
    paymentIntent: Stripe.PaymentIntent,
    checkoutTransactions: ChargeAmount["checkoutTransactions"],
  ): ClosePaymentIntentOutcome | null {
    if (paymentIntent.status === "canceled") {
      return "closed";
    }

    if (!isPaymentIntentMoneyMoving(paymentIntent.status)) {
      return null;
    }

    if (this.isUnrecordedPaymentInFlight(paymentIntent, checkoutTransactions)) {
      this.logger.warn(
        "A PaymentIntent of the checkout is being paid and Saleor has not recorded it",
        {
          paymentIntentId: paymentIntent.id,
          status: paymentIntent.status,
        },
      );

      return "payment-in-flight";
    }

    /*
     * Recorded in Saleor, so already counted in the amount due. Never cancelled: cancelling
     * a requires_capture intent would void an authorization that Saleor counts as held.
     */
    return "recorded";
  }

  /**
   * Makes sure one PaymentIntent of the checkout can no longer be paid, judged on its LIVE
   * status (the search index lags). One that can still be paid is cancelled: Stripe refuses
   * to cancel once the shopper confirmed, so a successful cancel means it is never paid. A
   * refused cancel is checked again against the live status.
   */
  private async closePaymentIntent(args: {
    stripePaymentIntentsApi: IStripePaymentIntentsApi;
    id: string;
    event: TransactionInitializeSessionEventFragment;
    checkoutTransactions: ChargeAmount["checkoutTransactions"];
  }): Promise<ClosePaymentIntentOutcome> {
    const { stripePaymentIntentsApi, checkoutTransactions } = args;
    const paymentIntentId = createStripePaymentIntentId(args.id);

    const retrieved = await stripePaymentIntentsApi.getPaymentIntent({ id: paymentIntentId });

    if (retrieved.isErr()) {
      if (isStripeResourceMissing(retrieved.error)) {
        // e.g. a test-mode PaymentIntent left on the checkout: it cannot be paid through this account.
        this.logger.warn(
          "A PaymentIntent of the checkout is unknown to this Stripe account; ignoring it",
          {
            paymentIntentId,
          },
        );

        return "not-ours";
      }

      this.logger.warn("Could not read a PaymentIntent of the checkout", {
        paymentIntentId,
        error: retrieved.error,
      });

      return "unverified";
    }

    if (!this.belongsToSource(retrieved.value, args.event.sourceObject)) {
      this.logger.warn(
        "A PaymentIntent linked to the checkout was created for another source; leaving it untouched",
        {
          paymentIntentId,
        },
      );

      return "not-ours";
    }

    const settled = this.settledOutcome(retrieved.value, checkoutTransactions);

    if (settled) {
      return settled;
    }

    const cancelResult = await stripePaymentIntentsApi.cancelPaymentIntent({ id: paymentIntentId });

    if (cancelResult.isOk()) {
      this.logger.info("Canceled another PaymentIntent of the checkout", { paymentIntentId });

      return "closed";
    }

    const live = await stripePaymentIntentsApi.getPaymentIntent({ id: paymentIntentId });
    const settledSince = live.isOk() ? this.settledOutcome(live.value, checkoutTransactions) : null;

    if (settledSince) {
      return settledSince;
    }

    this.logger.warn("Failed to cancel another PaymentIntent of the checkout", {
      paymentIntentId,
      error: cancelResult.error,
    });

    return "unverified";
  }

  private async closeOtherPaymentIntents(args: {
    stripePaymentIntentsApi: IStripePaymentIntentsApi;
    keep: StripePaymentIntentId | null;
    searchResults: ReadonlyArray<Stripe.PaymentIntent>;
    event: TransactionInitializeSessionEventFragment;
    checkoutTransactions: ChargeAmount["checkoutTransactions"];
  }): Promise<ReadonlyArray<ClosePaymentIntentOutcome>> {
    return mapWithConcurrency(
      this.otherPaymentIntentIds(args),
      MAX_CONCURRENT_PAYMENT_INTENT_CLOSES,
      (id) => this.closePaymentIntent({ ...args, id }),
    );
  }

  /**
   * Review M1: before a PaymentIntent is handed out (`keep`, or a new one when null), every
   * other PaymentIntent of the checkout is closed, on every path. Refused when one of them is
   * already being paid and Saleor has not recorded it (PaymentInFlightError; `keep` is then
   * closed too, because another tab may hold its client secret), or when one could be
   * neither read nor cancelled (OtherPaymentsUnverifiedError).
   */
  private async closeOthersBeforeHandOut(args: {
    stripePaymentIntentsApi: IStripePaymentIntentsApi;
    keep: StripePaymentIntentId | null;
    searchResults: ReadonlyArray<Stripe.PaymentIntent>;
    event: TransactionInitializeSessionEventFragment;
    checkoutTransactions: ChargeAmount["checkoutTransactions"];
  }): Promise<Result<void, PaymentAmountRefusal>> {
    const outcomes = await this.closeOtherPaymentIntents(args);

    if (outcomes.includes("payment-in-flight")) {
      if (args.keep) {
        await this.closePaymentIntent({ ...args, id: args.keep });
      }

      return err(new PaymentInFlightError("Another PaymentIntent of the checkout is being paid"));
    }

    if (outcomes.includes("unverified")) {
      return err(
        new OtherPaymentsUnverifiedError(
          "Another PaymentIntent of the checkout could be neither read nor cancelled",
        ),
      );
    }

    return ok(undefined);
  }

  /**
   * A PaymentIntent of the checkout is being paid and Saleor has not recorded it: no other
   * one may stay payable meanwhile, then the request is refused.
   */
  private async refuseWhilePaymentInFlight(args: {
    stripePaymentIntentsApi: IStripePaymentIntentsApi;
    inFlightPaymentIntentId: StripePaymentIntentId;
    event: TransactionInitializeSessionEventFragment;
    checkoutTransactions: ChargeAmount["checkoutTransactions"];
    message: string;
  }): Promise<StorefrontPaymentIntentOutcome> {
    await this.closeOtherPaymentIntents({
      ...args,
      keep: args.inFlightPaymentIntentId,
      searchResults: [],
    });

    return { outcome: "refused", error: new PaymentInFlightError(args.message) };
  }

  /**
   * Review round 2 (Q4): the exact-amount PaymentIntent comes from Stripe's search index,
   * which lags by up to about a minute behind Stripe. It is read again before it is handed
   * out, and only its live state counts:
   * - still open (a status that accepts an amount), same currency, amount owed -> hand out;
   * - still open, another amount (e.g. /api/update-payment-intent changed it) -> update;
   * - money moving and not recorded in Saleor -> refused (PaymentInFlightError);
   * - anything else (canceled, recorded, another source or currency) -> not reused.
   */
  private async reviewFoundPaymentIntent(args: {
    stripePaymentIntentsApi: IStripePaymentIntentsApi;
    id: StripePaymentIntentId;
    event: TransactionInitializeSessionEventFragment;
    stripeMoney: StripeMoney;
    checkoutTransactions: ChargeAmount["checkoutTransactions"];
  }): Promise<FoundPaymentIntentDecision> {
    const { stripePaymentIntentsApi, id, event, stripeMoney, checkoutTransactions } = args;

    const live = await stripePaymentIntentsApi.getPaymentIntent({ id });

    if (live.isErr()) {
      this.logger.warn("Could not read again the PaymentIntent found for the checkout", {
        paymentIntentId: id,
        error: live.error,
      });

      return {
        decision: "refused",
        error: new OtherPaymentsUnverifiedError(
          "The PaymentIntent found for the checkout could not be read again",
          { cause: live.error },
        ),
      };
    }

    const paymentIntent = live.value;

    if (!this.belongsToSource(paymentIntent, event.sourceObject)) {
      this.logger.warn(
        "The PaymentIntent found for the checkout was created for another source; not reusing it",
        { paymentIntentId: id },
      );

      return { decision: "create" };
    }

    if (this.isUnrecordedPaymentInFlight(paymentIntent, checkoutTransactions)) {
      this.logger.warn(
        "The PaymentIntent found for the checkout is already being paid; not starting another",
        { paymentIntentId: id, status: paymentIntent.status },
      );

      return {
        decision: "refused",
        error: new PaymentInFlightError("The PaymentIntent found for the checkout is being paid"),
      };
    }

    if (
      !isPaymentIntentAmountUpdatable(paymentIntent.status) ||
      paymentIntent.currency !== stripeMoney.currency
    ) {
      this.logger.info("The PaymentIntent found for the checkout can no longer be reused", {
        paymentIntentId: id,
        status: paymentIntent.status,
      });

      return { decision: "create" };
    }

    if (paymentIntent.amount !== stripeMoney.amount) {
      this.logger.info("The PaymentIntent found for the checkout changed amount since the search", {
        paymentIntentId: id,
        liveAmount: paymentIntent.amount,
        amountDue: stripeMoney.amount,
      });

      return { decision: "update", paymentIntent };
    }

    return { decision: "hand-out", paymentIntent };
  }

  private async updateTransactionWithPspReference(args: {
    transactionId: string;
    stripePaymentIntentId: StripePaymentIntentId;
    saleorApiUrl: SaleorApiUrl;
    appId: string;
  }): Promise<Result<void, InstanceType<typeof BaseError>>> {
    try {
      // Get the app token from APL
      const authData = await saleorApp.apl.get(args.saleorApiUrl);

      if (!authData) {
        this.logger.error("No auth data found for saleorApiUrl", {
          saleorApiUrl: args.saleorApiUrl,
        });

        return err(new BaseError("No authentication data found"));
      }

      const client = createInstrumentedGraphqlClient({
        saleorApiUrl: args.saleorApiUrl,
        token: authData.token,
      });

      const result = await client.mutation(TransactionUpdateDocument, {
        transactionId: args.transactionId,
        pspReference: args.stripePaymentIntentId,
      });

      const mutationErrors = result.data?.transactionUpdate?.errors ?? [];

      /*
       * Resuming an existing checkout creates a NEW Saleor transaction while the
       * Stripe PaymentIntent (and therefore the pspReference) is reused from the
       * previous session. Saleor's `transactionUpdate` rejects a pspReference that
       * already exists on another transaction with a UNIQUE error. This is NOT fatal:
       * Saleor also sets the pspReference natively from the webhook response (see
       * use-case-response.ts), so the reference is already linked. Returning an error
       * here produced a 500 that prevented the storefront from receiving the client
       * secret and initializing the Stripe payment gateway.
       */
      const onlyUniqueErrors =
        mutationErrors.length > 0 && mutationErrors.every((e) => e.code === "UNIQUE");

      if (onlyUniqueErrors) {
        this.logger.info(
          "pspReference already exists on an existing transaction (reused PaymentIntent) - treating as success",
          {
            transactionId: args.transactionId,
            pspReference: args.stripePaymentIntentId,
          },
        );

        return ok(undefined);
      }

      if (result.error || mutationErrors.length) {
        const errorMessage =
          mutationErrors.map((e) => e.message).join(", ") ||
          result.error?.message ||
          "Unknown error";

        this.logger.error("Failed to update transaction with pspReference", {
          transactionId: args.transactionId,
          pspReference: args.stripePaymentIntentId,
          errors: mutationErrors,
          graphqlError: result.error,
        });

        return err(new BaseError(`Failed to update transaction: ${errorMessage}`));
      }

      this.logger.info("Successfully updated transaction with pspReference", {
        transactionId: args.transactionId,
        pspReference: args.stripePaymentIntentId,
        updatedTransaction: result.data?.transactionUpdate?.transaction,
      });

      return ok(undefined);
    } catch (error) {
      this.logger.error("Exception while updating transaction with pspReference", {
        error,
        transactionId: args.transactionId,
        pspReference: args.stripePaymentIntentId,
      });

      return err(BaseError.normalize(error));
    }
  }

  async execute(args: {
    appId: string;
    saleorApiUrl: SaleorApiUrl;
    event: TransactionInitializeSessionEventFragment;
  }): Promise<UseCaseExecuteResult> {
    const { appId, saleorApiUrl, event } = args;

    const saleorTransactionFlow = createSaleorTransactionFlow(event.action.actionType);

    const eventDataResult = parseTransactionInitializeSessionEventData(event.data);

    if (eventDataResult.isErr()) {
      this.logger.warn("Failed to parse event data", { error: eventDataResult.error });

      return ok(
        new TransactionInitializeSessionUseCaseResponses.Failure({
          transactionResult: this.resolveErrorTransactionResult(saleorTransactionFlow),
          error: eventDataResult.error,
          appContext: appContextContainer.getContextValue(),
        }),
      );
    }

    const stripeConfigForThisChannel = await this.appConfigRepo.getStripeConfig({
      channelId: event.sourceObject.channel.id,
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
        channelId: event.sourceObject.channel.id,
      });

      return err(
        new AppIsNotConfiguredResponse(
          appContextContainer.getContextValue(),
          new BaseError("Config not found"),
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

    this.logger.debug("Creating Stripe payment intent with params", {
      params: args.event.action,
    });

    const selectedPaymentMethod = resolvePaymentMethodFromEventData(eventDataResult.value);
    const resolvedTransactionFlow =
      selectedPaymentMethod.getResolvedTransactionFlow(saleorTransactionFlow);

    // Before any Stripe write: what may this transaction charge? (NR-31)
    const chargeAmountResult = await this.resolveChargeAmount({
      event,
      saleorApiUrl,
      stripePaymentIntentsApi,
    });

    if (chargeAmountResult.isErr()) {
      const refusal = chargeAmountResult.error;

      if (refusal instanceof MalformedRequestResponse || refusal instanceof BrokenAppResponse) {
        return err(refusal);
      }

      return ok(this.refusedResponse(refusal, resolvedTransactionFlow));
    }

    const { stripeMoney, checkoutTransactions } = chargeAmountResult.value;

    // Check if storefront passed an existing PaymentIntent ID to update
    // This avoids Stripe's search API latency when the checkout amount changes
    const existingPaymentIntentIdFromStorefront = eventDataResult.value.existingPaymentIntentId;

    if (existingPaymentIntentIdFromStorefront) {
      this.logger.info("Storefront provided existing PaymentIntent ID, attempting to update", {
        existingPaymentIntentId: existingPaymentIntentIdFromStorefront,
      });

      const storefrontPaymentIntent = await this.tryStorefrontPaymentIntent({
        stripePaymentIntentsApi,
        existingPaymentIntentId: existingPaymentIntentIdFromStorefront,
        event,
        stripeMoney,
        checkoutTransactions,
      });

      if (storefrontPaymentIntent.outcome === "refused") {
        return ok(this.refusedResponse(storefrontPaymentIntent.error, resolvedTransactionFlow));
      }

      if (storefrontPaymentIntent.outcome === "updated") {
        const updatedPI = storefrontPaymentIntent.paymentIntent;

        this.logger.info("Successfully updated PaymentIntent via storefront-provided ID", {
          paymentIntentId: updatedPI.id,
          amount: updatedPI.amount,
        });

        const mappedResponseResult = this.mapStripePaymentIntentToWebhookResponse(updatedPI);

        if (mappedResponseResult.isOk()) {
          const [saleorMoney, stripePaymentIntentId, stripeClientSecret, stripeStatus] =
            mappedResponseResult.value;

          // Upsert the transaction record
          const recordedTransaction = new RecordedTransaction({
            saleorTransactionId: createSaleorTransactionId(event.transaction.id),
            stripePaymentIntentId,
            saleorTransactionFlow: saleorTransactionFlow,
            resolvedTransactionFlow: resolvedTransactionFlow,
            selectedPaymentMethod: selectedPaymentMethod.type,
          });

          const recordResult = await this.transactionRecorder.upsertTransaction(
            {
              saleorApiUrl: args.saleorApiUrl,
              appId: args.appId,
            },
            recordedTransaction,
          );

          if (recordResult.isErr()) {
            this.logger.error("Failed to upsert transaction for direct-updated PI", {
              error: recordResult.error,
              paymentIntentId: updatedPI.id,
            });

            return err(
              new BrokenAppResponse(appContextContainer.getContextValue(), recordResult.error),
            );
          }

          // Update Saleor transaction with pspReference
          const updateTransactionResult = await this.updateTransactionWithPspReference({
            transactionId: event.transaction.id,
            stripePaymentIntentId,
            saleorApiUrl: args.saleorApiUrl,
            appId: args.appId,
          });

          if (updateTransactionResult.isErr()) {
            this.logger.error("Failed to update transaction with pspReference (direct update)", {
              error: updateTransactionResult.error,
              transactionId: event.transaction.id,
              pspReference: stripePaymentIntentId,
            });

            return err(
              new BrokenAppResponse(
                appContextContainer.getContextValue(),
                updateTransactionResult.error,
              ),
            );
          }

          const transactionResult = this.resolveOkTransactionResult({
            transactionFlow: resolvedTransactionFlow,
            stripeStatus,
          });

          return ok(
            new TransactionInitializeSessionUseCaseResponses.Success({
              saleorMoney,
              stripePaymentIntentId,
              transactionResult,
              stripeClientSecret,
              appContext: appContextContainer.getContextValue(),
            }),
          );
        }
      }
    }

    // Check for existing payment intents for this checkout via Stripe search API
    // (fallback if storefront didn't provide an ID or update failed)
    const existingPaymentIntentsResult =
      await stripePaymentIntentsApi.searchPaymentIntentsByCheckout({
        checkoutId: event.sourceObject.id,
      });

    let foundPaymentIntents: ReadonlyArray<Stripe.PaymentIntent> = [];

    if (existingPaymentIntentsResult.isOk()) {
      foundPaymentIntents = existingPaymentIntentsResult.value;
    } else if (checkoutTransactions) {
      /*
       * Review round 2 (Q1): the search is not needed to find what a shopper can pay. Saleor
       * writes the pspReference of every transactionInitialize response on its transaction
       * before the storefront gets the client secret, so each payable PaymentIntent of the
       * checkout is on the list read above, and closeOthersBeforeHandOut checks them all
       * live (it still refuses when one can be neither read nor cancelled). The search only
       * finds a PaymentIntent to reuse. Logged as an error so an outage shows up.
       */
      this.logger.error(
        "Stripe search for the checkout's PaymentIntents failed; continuing with the PaymentIntents listed on the checkout's Saleor transactions",
        { error: existingPaymentIntentsResult.error },
      );
    } else {
      /*
       * Order source: no Saleor list of its PaymentIntents is read, so without the search one
       * could stay payable next to a new one. Refused (review M1); the caller can retry.
       */
      this.logger.warn(
        "Stripe search for the order's PaymentIntents failed; not starting a payment",
        { error: existingPaymentIntentsResult.error },
      );

      return ok(
        this.refusedResponse(
          new OtherPaymentsUnverifiedError("Stripe search for the order's PaymentIntents failed", {
            cause: existingPaymentIntentsResult.error,
          }),
          resolvedTransactionFlow,
        ),
      );
    }

    /** The PaymentIntent the checkout's other ones were already closed for (review M1). */
    let othersClosedFor: StripePaymentIntentId | null = null;
    /** The found PaymentIntent to update, decided on its live state (review round 2, Q4). */
    let liveUpdateCandidate: Stripe.PaymentIntent | null = null;
    /** Found PaymentIntents that their live state rules out for an update. */
    const notUpdatable = new Set<string>();

    if (foundPaymentIntents.length > 0) {
      this.logger.debug("Found existing payment intents for checkout", {
        count: foundPaymentIntents.length,
        paymentIntentIds: foundPaymentIntents.map((pi) => pi.id),
      });

      // Try to find a reusable payment intent that already holds the amount owed
      const reusablePI = foundPaymentIntents.find(
        (pi) =>
          pi.amount === stripeMoney.amount &&
          pi.currency === stripeMoney.currency &&
          pi.status === "requires_payment_method",
      );

      if (reusablePI) {
        this.logger.debug("Reusing existing payment intent", { paymentIntentId: reusablePI.id });

        const keep = createStripePaymentIntentId(reusablePI.id);

        const handOutAllowed = await this.closeOthersBeforeHandOut({
          stripePaymentIntentsApi,
          keep,
          searchResults: foundPaymentIntents,
          event,
          checkoutTransactions,
        });

        if (handOutAllowed.isErr()) {
          return ok(this.refusedResponse(handOutAllowed.error, resolvedTransactionFlow));
        }

        othersClosedFor = keep;

        // Review round 2 (Q4): the search index lags; only the live PaymentIntent is handed out.
        const found = await this.reviewFoundPaymentIntent({
          stripePaymentIntentsApi,
          id: keep,
          event,
          stripeMoney,
          checkoutTransactions,
        });

        if (found.decision === "refused") {
          return ok(this.refusedResponse(found.error, resolvedTransactionFlow));
        }

        if (found.decision === "update") {
          liveUpdateCandidate = found.paymentIntent;
        }

        if (found.decision === "create") {
          notUpdatable.add(keep);
        }

        const mappedResponseResult =
          found.decision === "hand-out"
            ? this.mapStripePaymentIntentToWebhookResponse(found.paymentIntent)
            : null;

        if (mappedResponseResult?.isOk()) {
          const [saleorMoney, stripePaymentIntentId, stripeClientSecret, stripeStatus] =
            mappedResponseResult.value;

          // Update transaction record with reused payment intent
          const recordedTransaction = new RecordedTransaction({
            saleorTransactionId: createSaleorTransactionId(event.transaction.id),
            stripePaymentIntentId,
            saleorTransactionFlow: saleorTransactionFlow,
            resolvedTransactionFlow: resolvedTransactionFlow,
            selectedPaymentMethod: selectedPaymentMethod.type,
          });

          const recordResult = await this.transactionRecorder.recordTransaction(
            {
              saleorApiUrl: args.saleorApiUrl,
              appId: args.appId,
            },
            recordedTransaction,
          );

          if (recordResult.isOk()) {
            this.logger.info("Reused existing payment intent", {
              paymentIntentId: reusablePI.id,
              transaction: recordedTransaction,
            });

            // Update Saleor transaction with the Stripe PaymentIntent ID as pspReference
            const updateTransactionResult = await this.updateTransactionWithPspReference({
              transactionId: event.transaction.id,
              stripePaymentIntentId,
              saleorApiUrl: args.saleorApiUrl,
              appId: args.appId,
            });

            if (updateTransactionResult.isErr()) {
              this.logger.error("Failed to update transaction with pspReference (reused PI)", {
                error: updateTransactionResult.error,
                transactionId: event.transaction.id,
                pspReference: stripePaymentIntentId,
              });

              // FIXED: Return error instead of continuing - pspReference must be set
              return err(
                new BrokenAppResponse(
                  appContextContainer.getContextValue(),
                  updateTransactionResult.error,
                ),
              );
            }

            const transactionResult = this.resolveOkTransactionResult({
              transactionFlow: resolvedTransactionFlow,
              stripeStatus,
            });

            return ok(
              new TransactionInitializeSessionUseCaseResponses.Success({
                saleorMoney,
                stripePaymentIntentId,
                transactionResult,
                stripeClientSecret,
                appContext: appContextContainer.getContextValue(),
              }),
            );
          }
        }
      }

      // STRIPE BEST PRACTICE: If we have an existing PaymentIntent with different amount,
      // UPDATE it instead of canceling and creating a new one.
      // This preserves the clientSecret so the storefront doesn't need to remount Elements.
      const updatablePI =
        liveUpdateCandidate ??
        foundPaymentIntents.find(
          (pi) =>
            !notUpdatable.has(pi.id) &&
            pi.status === "requires_payment_method" &&
            pi.currency === stripeMoney.currency,
        );

      if (updatablePI) {
        this.logger.info("Updating existing payment intent with new amount", {
          paymentIntentId: updatablePI.id,
          oldAmount: updatablePI.amount,
          newAmount: stripeMoney.amount,
        });

        const keep = createStripePaymentIntentId(updatablePI.id);

        // Already done when the reuse check above chose this PaymentIntent.
        if (othersClosedFor !== keep) {
          const handOutAllowed = await this.closeOthersBeforeHandOut({
            stripePaymentIntentsApi,
            keep,
            searchResults: foundPaymentIntents,
            event,
            checkoutTransactions,
          });

          if (handOutAllowed.isErr()) {
            return ok(this.refusedResponse(handOutAllowed.error, resolvedTransactionFlow));
          }
        }

        // Update the PaymentIntent's amount
        const updateResult = await stripePaymentIntentsApi.updatePaymentIntent({
          id: createStripePaymentIntentId(updatablePI.id),
          stripeMoney,
          metadata: {
            saleor_transaction_id: createSaleorTransactionId(event.transaction.id),
          },
          idempotencyKey: `update_${event.idempotencyKey}`,
        });

        if (updateResult.isOk()) {
          const updatedPI = updateResult.value;

          this.logger.debug("Successfully updated payment intent amount", {
            paymentIntentId: updatedPI.id,
            newAmount: updatedPI.amount,
          });

          const mappedResponseResult = this.mapStripePaymentIntentToWebhookResponse(updatedPI);

          if (mappedResponseResult.isOk()) {
            const [saleorMoney, stripePaymentIntentId, stripeClientSecret, stripeStatus] =
              mappedResponseResult.value;

            // Upsert the transaction - use upsert because the PaymentIntent may already have
            // a record from a previous Saleor transaction (before the amount was updated)
            const recordedTransaction = new RecordedTransaction({
              saleorTransactionId: createSaleorTransactionId(event.transaction.id),
              stripePaymentIntentId,
              saleorTransactionFlow: saleorTransactionFlow,
              resolvedTransactionFlow: resolvedTransactionFlow,
              selectedPaymentMethod: selectedPaymentMethod.type,
            });

            const recordResult = await this.transactionRecorder.upsertTransaction(
              {
                saleorApiUrl: args.saleorApiUrl,
                appId: args.appId,
              },
              recordedTransaction,
            );

            if (recordResult.isErr()) {
              this.logger.error("Failed to upsert transaction for updated PI", {
                error: recordResult.error,
                paymentIntentId: updatedPI.id,
              });

              return err(
                new BrokenAppResponse(appContextContainer.getContextValue(), recordResult.error),
              );
            }

            this.logger.info("Updated and reused existing payment intent", {
              paymentIntentId: updatedPI.id,
              transaction: recordedTransaction,
            });

            // Update Saleor transaction with the Stripe PaymentIntent ID as pspReference
            const updateTransactionResult = await this.updateTransactionWithPspReference({
              transactionId: event.transaction.id,
              stripePaymentIntentId,
              saleorApiUrl: args.saleorApiUrl,
              appId: args.appId,
            });

            if (updateTransactionResult.isErr()) {
              this.logger.error("Failed to update transaction with pspReference (updated PI)", {
                error: updateTransactionResult.error,
                transactionId: event.transaction.id,
                pspReference: stripePaymentIntentId,
              });

              return err(
                new BrokenAppResponse(
                  appContextContainer.getContextValue(),
                  updateTransactionResult.error,
                ),
              );
            }

            const transactionResult = this.resolveOkTransactionResult({
              transactionFlow: resolvedTransactionFlow,
              stripeStatus,
            });

            return ok(
              new TransactionInitializeSessionUseCaseResponses.Success({
                saleorMoney,
                stripePaymentIntentId,
                transactionResult,
                stripeClientSecret,
                appContext: appContextContainer.getContextValue(),
              }),
            );
          }
        } else {
          this.logger.warn("Failed to update payment intent, will create new one", {
            paymentIntentId: updatablePI.id,
            error: updateResult.error,
          });
        }
      }
    }

    /*
     * Nothing to reuse or update: before a new PaymentIntent exists, every other one of the
     * checkout (found by the search or listed on its Saleor transactions) is closed. One that
     * is processing or paid and not yet recorded in Saleor refuses the request: a new
     * PaymentIntent would let the shopper pay twice.
     */
    const createAllowed = await this.closeOthersBeforeHandOut({
      stripePaymentIntentsApi,
      keep: null,
      searchResults: foundPaymentIntents,
      event,
      checkoutTransactions,
    });

    if (createAllowed.isErr()) {
      return ok(this.refusedResponse(createAllowed.error, resolvedTransactionFlow));
    }

    const stripePaymentIntentParams = this.prepareStripeCreatePaymentIntentParams({
      eventData: eventDataResult.value,
      event: event,
      stripeMoney,
      selectedPaymentMethodOptions:
        selectedPaymentMethod.getCreatePaymentIntentMethodOptions(saleorTransactionFlow),
      idempotencyKey: event.idempotencyKey,
    });

    const createPaymentIntentResult =
      await stripePaymentIntentsApi.createPaymentIntent(stripePaymentIntentParams);

    if (createPaymentIntentResult.isErr()) {
      const mappedError = mapStripeErrorToApiError(createPaymentIntentResult.error);

      this.logger.error("Failed to create payment intent", { error: mappedError });

      return ok(
        new TransactionInitializeSessionUseCaseResponses.Failure({
          transactionResult: this.resolveErrorTransactionResult(resolvedTransactionFlow),
          error: mappedError,
          appContext: appContextContainer.getContextValue(),
        }),
      );
    }

    const stripePaymentIntent = createPaymentIntentResult.value;

    loggerContext.set(ObservabilityAttributes.PSP_REFERENCE, stripePaymentIntent.id);

    this.logger.debug("Stripe created payment intent", { stripeResponse: stripePaymentIntent });

    const mappedResponseResult = this.mapStripePaymentIntentToWebhookResponse(stripePaymentIntent);

    if (mappedResponseResult.isErr()) {
      captureException(mappedResponseResult.error);
      this.logger.error("Failed to map Stripe Payment Intent to webhook response", {
        error: mappedResponseResult.error,
      });

      return err(
        new BrokenAppResponse(appContextContainer.getContextValue(), mappedResponseResult.error),
      );
    }

    const [saleorMoney, stripePaymentIntentId, stripeClientSecret, stripeStatus] =
      mappedResponseResult.value;

    const recordedTransaction = new RecordedTransaction({
      saleorTransactionId: createSaleorTransactionId(event.transaction.id),
      stripePaymentIntentId,
      saleorTransactionFlow: saleorTransactionFlow,
      resolvedTransactionFlow: resolvedTransactionFlow,
      selectedPaymentMethod: selectedPaymentMethod.type,
    });

    const recordResult = await this.transactionRecorder.recordTransaction(
      {
        saleorApiUrl: args.saleorApiUrl,
        appId: args.appId,
      },
      recordedTransaction,
    );

    if (recordResult.isErr()) {
      this.logger.error("Failed to record transaction", {
        error: recordResult.error,
      });

      return err(new BrokenAppResponse(appContextContainer.getContextValue(), recordResult.error));
    }

    this.logger.info("Wrote Transaction to DynamoDB", {
      transaction: recordedTransaction,
    });

    /*
     * Update Saleor transaction with the Stripe PaymentIntent ID as pspReference
     * FIXED: Make this operation blocking - if it fails, the whole operation should fail
     * This ensures pspReference is properly set before the webhook returns success
     */
    const updateTransactionResult = await this.updateTransactionWithPspReference({
      transactionId: event.transaction.id,
      stripePaymentIntentId,
      saleorApiUrl: args.saleorApiUrl,
      appId: args.appId,
    });

    if (updateTransactionResult.isErr()) {
      this.logger.error("Failed to update transaction with pspReference", {
        error: updateTransactionResult.error,
        transactionId: event.transaction.id,
        pspReference: stripePaymentIntentId,
      });

      // Return error instead of continuing - pspReference must be set
      return err(
        new BrokenAppResponse(appContextContainer.getContextValue(), updateTransactionResult.error),
      );
    }

    const transactionResult = this.resolveOkTransactionResult({
      transactionFlow: resolvedTransactionFlow,
      stripeStatus,
    });

    return ok(
      new TransactionInitializeSessionUseCaseResponses.Success({
        saleorMoney,
        stripePaymentIntentId,
        transactionResult,
        stripeClientSecret,
        appContext: appContextContainer.getContextValue(),
      }),
    );
  }
}
