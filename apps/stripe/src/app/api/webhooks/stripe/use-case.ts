import { APL, AuthData } from "@saleor/app-sdk/APL";
import { ObservabilityAttributes } from "@saleor/apps-otel/src/observability-attributes";
import { captureException } from "@sentry/nextjs";
import { err, ok, Result } from "neverthrow";
import Stripe from "stripe";

import { appContextContainer } from "@/lib/app-context";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { loggerContext } from "@/lib/logger-context";
import { AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { IPaypalCaptureTrigger } from "@/modules/paypal-capture/capture-check-scheduler";
import { resolveReleasedRemainderReport } from "@/modules/saleor/released-remainder";
import { SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import {
  ITransactionEventReporter,
  TransactionEventReporterErrors,
} from "@/modules/saleor/transaction-event-reporter";
import { ITransactionEventsFetcher } from "@/modules/saleor/transaction-events-fetcher";
import { StripeClient } from "@/modules/stripe/stripe-client";
import { StripeEnv } from "@/modules/stripe/stripe-env";
import { StripeRestrictedKey } from "@/modules/stripe/stripe-restricted-key";
import { createTimestampFromStripeEvent } from "@/modules/stripe/stripe-timestamps";
import { StripeWebhookManager } from "@/modules/stripe/stripe-webhook-manager";
import { AllowedStripeObjectMetadata, IStripeEventVerify } from "@/modules/stripe/types";
import {
  TransactionRecorderError,
  TransactionRecorderRepo,
} from "@/modules/transactions-recording/repositories/transaction-recorder-repo";

import { StripePaymentIntentHandler } from "./stripe-object-handlers/stripe-payment-intent-handler";
import { StripeRefundHandler } from "./stripe-object-handlers/stripe-refund-handler";
import {
  ObjectCreatedOutsideOfSaleorResponse,
  PossibleStripeWebhookErrorResponses,
  PossibleStripeWebhookSuccessResponses,
  StripeWebhookAppIsNotConfiguredResponse,
  StripeWebhookMalformedRequestResponse,
  StripeWebhookSeverErrorResponse,
  StripeWebhookSuccessResponse,
  StripeWebhookTransactionMissingResponse,
} from "./stripe-webhook-responses";
import { WebhookParams } from "./webhook-params";

type R = Promise<
  Result<PossibleStripeWebhookSuccessResponses, PossibleStripeWebhookErrorResponses>
>;

type StripeVerifyEventFactory = (stripeClient: StripeClient) => IStripeEventVerify;
type SaleorTransactionEventReporterFactory = (authData: AuthData) => ITransactionEventReporter;
type SaleorTransactionEventsFetcherFactory = (authData: AuthData) => ITransactionEventsFetcher;

const ObjectMetadataMissingError = BaseError.subclass("ObjectMetadataMissingError");

export class StripeWebhookUseCase {
  private appConfigRepo: AppConfigRepo;
  private webhookEventVerifyFactory: StripeVerifyEventFactory;
  private apl: APL;
  private logger = createLogger("StripeWebhookUseCase");
  private transactionRecorder: TransactionRecorderRepo;
  private transactionEventReporterFactory: SaleorTransactionEventReporterFactory;
  private transactionEventsFetcherFactory: SaleorTransactionEventsFetcherFactory;
  private webhookManager: StripeWebhookManager;
  private paypalCaptureTrigger: IPaypalCaptureTrigger | null;

  constructor(deps: {
    appConfigRepo: AppConfigRepo;
    webhookEventVerifyFactory: StripeVerifyEventFactory;
    apl: APL;
    transactionRecorder: TransactionRecorderRepo;
    transactionEventReporterFactory: SaleorTransactionEventReporterFactory;
    /** Reads a Saleor transaction's events with the app token (refunds, A2e). */
    transactionEventsFetcherFactory: SaleorTransactionEventsFetcherFactory;
    webhookManager: StripeWebhookManager;
    /** A3d "soon" capture checks; null or absent with the PayPal-fee gate off. */
    paypalCaptureTrigger?: IPaypalCaptureTrigger | null;
  }) {
    this.appConfigRepo = deps.appConfigRepo;
    this.webhookEventVerifyFactory = deps.webhookEventVerifyFactory;
    this.apl = deps.apl;
    this.transactionRecorder = deps.transactionRecorder;
    this.transactionEventReporterFactory = deps.transactionEventReporterFactory;
    this.transactionEventsFetcherFactory = deps.transactionEventsFetcherFactory;
    this.webhookManager = deps.webhookManager;
    this.paypalCaptureTrigger = deps.paypalCaptureTrigger ?? null;
  }

  private async removeStripeWebhook({
    webhookId,
    restrictedKey,
  }: {
    webhookId: string;
    restrictedKey: StripeRestrictedKey;
  }) {
    const result = await this.webhookManager.removeWebhook({ webhookId, restrictedKey });

    if (result.isErr()) {
      this.logger.error(`Failed to remove webhook ${webhookId}`, result.error);

      return err(new BaseError("Failed to remove webhook", { cause: result.error }));
    }

    this.logger.info(`Webhook ${webhookId} removed successfully`);

    return ok(null);
  }

  private async processEvent({
    event,
    saleorApiUrl,
    appId,
    stripeEnv,
    transactionEventsFetcher,
  }: {
    event: Stripe.Event;
    saleorApiUrl: SaleorApiUrl;
    appId: string;
    stripeEnv: StripeEnv;
    transactionEventsFetcher: ITransactionEventsFetcher;
  }) {
    switch (event.data.object.object) {
      case "payment_intent": {
        loggerContext.set(ObservabilityAttributes.PSP_REFERENCE, event.data.object.id);

        const meta = event.data.object.metadata as AllowedStripeObjectMetadata;

        if (!meta?.saleor_transaction_id) {
          return err(
            new ObjectMetadataMissingError(
              "Missing metadata on object, it was not created by Saleor",
              {
                props: {
                  meta,
                },
              },
            ),
          );
        }

        const handler = new StripePaymentIntentHandler();

        return handler.processPaymentIntentEvent({
          event,
          stripeEnv,
          transactionRecorder: this.transactionRecorder,
          appId,
          saleorApiUrl,
        });
      }

      case "refund": {
        loggerContext.set("stripeRefundId", event.data.object.id);

        /*
         * Unlike payment intents, refunds are processed even without Saleor metadata: a refund
         * issued straight from the Stripe Dashboard has none, yet it moves real money out of a
         * payment intent the app knows about, so Saleor must hear about it. The transaction is
         * resolved from the payment intent id; if that intent was not recorded by this app, the
         * handler fails with TransactionMissingError and the event is rejected as not ours.
         */
        if (!StripeRefundHandler.isCreatedBySaleor(event.data.object)) {
          this.logger.info("Processing refund created outside of Saleor", {
            stripeRefundId: event.data.object.id,
            eventType: event.type,
          });
        }

        const handler = new StripeRefundHandler();

        return handler.processRefundEvent({
          event,
          stripeEnv,
          transactionRecorder: this.transactionRecorder,
          transactionEventsFetcher,
          appId,
          saleorApiUrl,
        });
      }

      default: {
        throw new BaseError(`Support for object ${event.data.object.object} not implemented`);
      }
    }
  }

  /**
   * It handles case when
   * 1. App was installed and configured. Webhook exists in Stripe
   * 2. App is removed - webhook is not
   * 3. App is reinstalled and configured again
   * 4. There are now 2 webhooks - old and new. Old one will always fail.
   *
   * At this point we detect an old webhook because it has different appId in URL (from previous installation).
   * Now we can use that to fetch old config from DB and remove the webhook.
   */
  private async processLegacyWebhook(webhookParams: WebhookParams) {
    const legacyConfig = await this.appConfigRepo.getStripeConfig({
      configId: webhookParams.configurationId,
      // Use app ID from webhook, not AuthData, so we have it frozen in time
      appId: webhookParams.appId,
      saleorApiUrl: webhookParams.saleorApiUrl,
    });

    if (legacyConfig.isErr()) {
      captureException(
        new BaseError(
          "Failed to fetch config attached to legacy Webhook, this requires manual cleanup",
          {
            cause: legacyConfig.error,
          },
        ),
      );

      return err(
        new BaseError("Failed to fetch legacy config", {
          cause: legacyConfig.error,
        }),
      );
    }

    if (!legacyConfig.value) {
      this.logger.error("Legacy config is empty, this requires manual cleanup");

      return err(new BaseError("Legacy config is empty"));
    }

    const removalResult = await this.removeStripeWebhook({
      webhookId: legacyConfig.value.webhookId,
      restrictedKey: legacyConfig.value.restrictedKey,
    });

    if (removalResult.isErr()) {
      return err(new BaseError("Failed to remove legacy webhook", { cause: removalResult.error }));
    }

    return ok(null);
  }

  async execute({
    rawBody,
    signatureHeader,
    webhookParams,
  }: {
    /**
     * Raw request body for signature verification
     */
    rawBody: string;
    /**
     * Header that Stripe sends with webhook
     */
    signatureHeader: string;
    /**
     * Parsed params that come from Stripe Webhook
     */
    webhookParams: WebhookParams;
  }): R {
    this.logger.debug("Executing");
    const authData = await this.apl.get(webhookParams.saleorApiUrl);

    if (!authData) {
      captureException(
        new BaseError("AuthData from APL is empty, installation may be broken"),
        (s) => s.setLevel("warning"),
      );

      return err(new StripeWebhookAppIsNotConfiguredResponse());
    }

    if (authData.appId !== webhookParams.appId) {
      this.logger.warn(
        "Received webhook with different appId than expected. There may be old webhook from uninstalled app. Will try to remove it now.",
      );

      const processingResult = await this.processLegacyWebhook(webhookParams);

      if (processingResult.isErr()) {
        this.logger.error("Received legacy webhook but failed to handle removing it", {
          error: processingResult.error,
        });

        return err(new StripeWebhookAppIsNotConfiguredResponse());
      } else {
        return ok(new StripeWebhookSuccessResponse());
      }
    }

    const transactionEventReporter = this.transactionEventReporterFactory(authData);

    const config = await this.appConfigRepo.getStripeConfig({
      configId: webhookParams.configurationId,
      appId: authData.appId,
      saleorApiUrl: webhookParams.saleorApiUrl,
    });

    this.logger.debug("Configuration for config resolved");

    if (config.isErr()) {
      this.logger.error("Failed to fetch config from database", {
        error: config.error,
      });

      captureException(config.error);

      return err(new StripeWebhookAppIsNotConfiguredResponse());
    }

    if (!config.value) {
      this.logger.error("Config for given webhook is missing");

      return err(new StripeWebhookAppIsNotConfiguredResponse());
    }

    appContextContainer.set({
      stripeEnv: config.value.getStripeEnvValue(),
    });

    const stripeClient = StripeClient.createFromRestrictedKey(config.value.restrictedKey);
    const eventVerifier = this.webhookEventVerifyFactory(stripeClient);

    const event = eventVerifier.verifyEvent({
      rawBody,
      webhookSecret: config.value.webhookSecret,
      signatureHeader,
    });

    this.logger.debug("Event verified");

    if (event.isErr()) {
      this.logger.error("Failed to verify event", {
        error: event.error,
      });

      return err(new StripeWebhookMalformedRequestResponse());
    }

    this.logger.debug(`Resolved event type: ${event.value.type}`);

    const processingResult = await this.processEvent({
      event: event.value,
      saleorApiUrl: webhookParams.saleorApiUrl,
      appId: authData.appId,
      stripeEnv: config.value.getStripeEnvValue(),
      transactionEventsFetcher: this.transactionEventsFetcherFactory(authData),
    });

    if (processingResult.isErr()) {
      /**
       * This is technically not an error, so we catch it here without the error log.
       */
      if (processingResult.error instanceof ObjectMetadataMissingError) {
        return err(new ObjectCreatedOutsideOfSaleorResponse());
      }

      /*
       * A2e round 2 (P1): expected and retryable. A non-2xx answer makes Stripe re-send the
       * event; by then Saleor has tagged its refund request and the report is linked.
       */
      if (processingResult.error instanceof StripeRefundHandler.RefundRequestNotTaggedYetError) {
        this.logger.warn("Refund report deferred until Saleor tags its refund request", {
          error: processingResult.error.message,
        });

        return err(new StripeWebhookSeverErrorResponse());
      }

      this.logger.error("Failed to process event", {
        error: processingResult.error,
      });

      if (processingResult.error instanceof TransactionRecorderError.TransactionMissingError) {
        return err(new StripeWebhookTransactionMissingResponse());
      }

      return err(new StripeWebhookSeverErrorResponse());
    }

    const reportResult = await transactionEventReporter.reportTransactionEvent(
      processingResult.value.resolveEventReportVariables(),
    );

    this.logger.info("Transaction event reported", {
      transactionId: processingResult.value.saleorTransactionId,
      amount: processingResult.value.saleorMoney.amount,
      result: processingResult.value.transactionResult,
    });

    if (reportResult.isErr()) {
      if (!(reportResult.error instanceof TransactionEventReporterErrors.AlreadyReportedError)) {
        this.logger.error("Failed to report transaction event", {
          error: reportResult.error,
        });

        return err(new StripeWebhookSeverErrorResponse());
      }

      this.logger.info("Transaction event already reported");
    }

    // S2 ledger fix (all shops): what Stripe released after a partial capture.
    const remainderResult = await this.reportReleasedRemainder({
      event: event.value,
      saleorTransactionId: processingResult.value.saleorTransactionId,
      stripeEnv: config.value.getStripeEnvValue(),
      transactionEventReporter,
    });

    if (remainderResult.isErr()) {
      return err(new StripeWebhookSeverErrorResponse());
    }

    // A3d (gate on only): check this authorization for capture soon.
    if (processingResult.value.transactionResult.result === "AUTHORIZATION_SUCCESS") {
      this.notifyAuthorizationSuccess({
        event: event.value,
        saleorApiUrl: webhookParams.saleorApiUrl,
        appId: authData.appId,
        configId: webhookParams.configurationId,
      });
    }

    return ok(new StripeWebhookSuccessResponse());
  }

  /**
   * Spike S2 (sandbox, 2026-10-23): a partial capture releases the rest of the authorization at
   * Stripe, with no refund.* event, and Saleor 3.22.74 keeps that rest in authorizedAmount. On
   * payment_intent.succeeded with amount_received < amount, the rest is reported as
   * CANCEL_SUCCESS under "<pi>:released" (resolveReleasedRemainderReport), after the
   * CHARGE_SUCCESS (new or already recorded). Not gated: every shop's ledger needs it. A full
   * capture reports nothing more, as before.
   *
   * Idempotent: the report is the same each time, and Saleor answers a repeat
   * `alreadyProcessed`. A failure answers 500, so Stripe re-sends the event: the CHARGE_SUCCESS
   * is then already recorded, and the remainder is reported again.
   */
  private async reportReleasedRemainder(args: {
    event: Stripe.Event;
    saleorTransactionId: string;
    stripeEnv: StripeEnv;
    transactionEventReporter: ITransactionEventReporter;
  }): Promise<Result<void, InstanceType<typeof BaseError>>> {
    if (args.event.type !== "payment_intent.succeeded") {
      return ok(undefined);
    }

    const reportInput = resolveReleasedRemainderReport({
      paymentIntent: args.event.data.object,
      saleorTransactionId: args.saleorTransactionId,
      time: createTimestampFromStripeEvent(args.event),
      stripeEnv: args.stripeEnv,
    });

    if (reportInput.isErr()) {
      this.logger.error("Failed to resolve the released remainder of a partial capture", {
        error: reportInput.error,
      });

      return err(reportInput.error);
    }

    if (!reportInput.value) {
      return ok(undefined);
    }

    const reportResult = await args.transactionEventReporter.reportTransactionEvent(
      reportInput.value,
    );

    if (reportResult.isOk()) {
      this.logger.info("Reported the remainder Stripe released after a partial capture", {
        transactionId: args.saleorTransactionId,
        pspReference: reportInput.value.pspReference,
        amount: reportInput.value.amount.amount,
      });

      return ok(undefined);
    }

    if (reportResult.error instanceof TransactionEventReporterErrors.AlreadyReportedError) {
      this.logger.info("Released remainder already reported", {
        pspReference: reportInput.value.pspReference,
      });

      return ok(undefined);
    }

    this.logger.error("Failed to report the remainder Stripe released after a partial capture", {
      error: reportResult.error,
      pspReference: reportInput.value.pspReference,
    });

    return err(reportResult.error);
  }

  /**
   * A3d: after AUTHORIZATION_SUCCESS (payment_intent.amount_capturable_updated, spike S1), a
   * paypal-only PaymentIntent is checked for capture soon (+15/+45/+120 s). Only with the
   * PayPal-fee gate on (the trigger is null otherwise). A scheduling failure never fails the
   * webhook: the 60 s sweep still finds the authorization.
   */
  private notifyAuthorizationSuccess(args: {
    event: Stripe.Event;
    saleorApiUrl: SaleorApiUrl;
    appId: string;
    configId: string;
  }) {
    if (!this.paypalCaptureTrigger || args.event.data.object.object !== "payment_intent") {
      return;
    }

    try {
      this.paypalCaptureTrigger.onAuthorizationSuccess({
        saleorApiUrl: args.saleorApiUrl,
        appId: args.appId,
        paymentIntent: args.event.data.object,
        stripeConfig: { configId: args.configId },
      });
    } catch (error) {
      this.logger.error("Failed to schedule the capture checks of an authorization", { error });
    }
  }
}
