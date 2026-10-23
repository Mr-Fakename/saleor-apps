import { APL, AuthData } from "@saleor/app-sdk/APL";
import { randomUUID } from "crypto";
import { hostname } from "os";

import { env } from "@/lib/env";
import { createInstrumentedGraphqlClient } from "@/lib/graphql-client";
import { createLogger } from "@/lib/logger";
import { saleorApp } from "@/lib/saleor-app";
import { AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { appConfigRepoImpl } from "@/modules/app-config/repositories/app-config-repo-impl";
import { createDynamoDBClient, createDynamoDBDocumentClient } from "@/modules/dynamodb/dynamodb-client";
import {
  PaymentFeeGateConfig,
  paymentFeeGateFromEnv,
} from "@/modules/payment-fee-gate/payment-fee-gate-config";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { createStripePaymentIntentId } from "@/modules/stripe/stripe-payment-intent-id";
import { StripePaymentIntentsApi } from "@/modules/stripe/stripe-payment-intents-api";
import { StripeRestrictedKey } from "@/modules/stripe/stripe-restricted-key";
import { transactionRecorder as defaultTransactionRecorder } from "@/modules/transactions-recording/repositories/transaction-recorder-impl";
import { TransactionRecorderRepo } from "@/modules/transactions-recording/repositories/transaction-recorder-repo";

import { CaptureCheckScheduler, IPaypalCaptureTrigger, PaypalCaptureCheckTarget } from "./capture-check-scheduler";
import { ICaptureCoordinationRepo } from "./capture-coordination-repo";
import { DynamoDBCaptureCoordinationRepo } from "./dynamodb-capture-coordination-repo";
import { PaypalCaptureCoordinator } from "./paypal-capture-coordinator";
import { PaypalCaptureSweeper } from "./paypal-capture-sweeper";
import { PaypalCaptureWorker } from "./paypal-capture-worker";
import { ISaleorCaptureGateway, SaleorCaptureGateway } from "./saleor-capture-gateway";
import { IPaypalCaptureStripeApi } from "./types";

const RUNTIME_REGISTRY_KEY = "__saleorStripePaypalCaptureRuntime";

export type PaypalCaptureRuntime = {
  coordinator: PaypalCaptureCoordinator;
  scheduler: CaptureCheckScheduler;
  sweeper: PaypalCaptureSweeper;
  worker: PaypalCaptureWorker;
};

/** The A3d pieces wired together; the worker is not started here (src/instrumentation.ts does). */
export const createPaypalCaptureRuntime = (deps: {
  gate: PaymentFeeGateConfig;
  apl: Pick<APL, "get" | "getAll">;
  appConfigRepo: Pick<AppConfigRepo, "getStripeConfig" | "getRootConfig">;
  transactionRecorder: Pick<TransactionRecorderRepo, "getTransactionByStripePaymentIntentId">;
  repo: ICaptureCoordinationRepo;
  createStripeApi: (key: StripeRestrictedKey) => IPaypalCaptureStripeApi;
  createSaleorGateway: (authData: AuthData) => ISaleorCaptureGateway;
  holderId: string;
}): PaypalCaptureRuntime => {
  const logger = createLogger("PaypalCaptureRuntime");
  const coordinator = new PaypalCaptureCoordinator({
    repo: deps.repo,
    transactionRecorder: deps.transactionRecorder,
    gate: deps.gate,
    holderId: deps.holderId,
  });

  // Assigned below: runCheck schedules its follow-ups on the scheduler that runs it.
  let scheduler: CaptureCheckScheduler;

  /** A "soon" or follow-up check: resolves the installation and Stripe key, then one check. */
  const runCheck = async (target: PaypalCaptureCheckTarget) => {
    const saleorApiUrl = createSaleorApiUrl(target.saleorApiUrl);

    if (saleorApiUrl.isErr()) {
      logger.error("PayPal capture check: invalid Saleor API URL", { error: saleorApiUrl.error });

      return;
    }

    const authData = await deps.apl.get(saleorApiUrl.value);

    if (!authData) {
      logger.warn("PayPal capture check: the app is not installed for this Saleor", {
        saleorApiUrl: saleorApiUrl.value,
      });

      return;
    }

    const config = await deps.appConfigRepo.getStripeConfig({
      ...target.stripeConfig,
      saleorApiUrl: saleorApiUrl.value,
      appId: target.appId,
    });

    if (config.isErr() || !config.value) {
      logger.warn("PayPal capture check: no Stripe configuration; the sweep will check it", {
        paymentIntentId: target.paymentIntentId,
        error: config.isErr() ? config.error : null,
      });

      return;
    }

    return coordinator.checkPaymentIntent({
      access: { saleorApiUrl: saleorApiUrl.value, appId: target.appId },
      stripe: deps.createStripeApi(config.value.restrictedKey),
      saleor: deps.createSaleorGateway(authData),
      paymentIntentId: createStripePaymentIntentId(target.paymentIntentId),
      trigger: "soon",
      scheduleFollowUp: (delayMs) => scheduler.scheduleFollowUp(target, delayMs),
    });
  };

  scheduler = new CaptureCheckScheduler({ runCheck });

  const sweeper = new PaypalCaptureSweeper({
    apl: deps.apl,
    appConfigRepo: deps.appConfigRepo,
    repo: deps.repo,
    coordinator,
    createStripeApi: deps.createStripeApi,
    createSaleorGateway: deps.createSaleorGateway,
    scheduleFollowUp: (target, delayMs) => scheduler.scheduleFollowUp(target, delayMs),
    holderId: deps.holderId,
  });

  const worker = new PaypalCaptureWorker({ sweep: () => sweeper.sweep() });

  return { coordinator, scheduler, sweeper, worker };
};

/**
 * The process's A3d runtime with the PayPal-fee gate on, created once (globalThis: the route
 * bundles and src/instrumentation.ts share it); null with the gate off, and then nothing is
 * created at all.
 */
export const getPaypalCaptureRuntime = (
  registry: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): PaypalCaptureRuntime | null => {
  const gate = paymentFeeGateFromEnv(env);

  if (!gate) {
    return null;
  }

  const existing = registry[RUNTIME_REGISTRY_KEY] as PaypalCaptureRuntime | undefined;

  if (existing) {
    return existing;
  }

  const runtime = createPaypalCaptureRuntime({
    gate,
    apl: saleorApp.apl,
    appConfigRepo: appConfigRepoImpl,
    transactionRecorder: defaultTransactionRecorder,
    repo: new DynamoDBCaptureCoordinationRepo({
      documentClient: createDynamoDBDocumentClient(createDynamoDBClient()),
      tableName: env.DYNAMODB_MAIN_TABLE_NAME,
    }),
    createStripeApi: (key) => {
      const api = StripePaymentIntentsApi.createFromKey({ key });

      return {
        /*
         * The bounded read of the charge/cancel handlers (2.5 s, no retry): a check must end
         * well inside its 60 s claim lock (CAPTURE_CLAIM_LOCK_MS).
         */
        getPaymentIntent: (args) => api.getPaymentIntentForTransactionAction(args),
        searchPaymentIntentsAwaitingAppCapture: () => api.searchPaymentIntentsAwaitingAppCapture(),
      };
    },
    createSaleorGateway: (authData) =>
      new SaleorCaptureGateway(
        createInstrumentedGraphqlClient({
          // The APL's https-enforced URL, so the app token never goes out over plain http.
          saleorApiUrl: authData.saleorApiUrl,
          token: authData.token,
        }),
      ),
    holderId: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
  });

  registry[RUNTIME_REGISTRY_KEY] = runtime;

  return runtime;
};

/** For the routes: the "soon" trigger with the gate on, null with it off. */
export const getPaypalCaptureTrigger = (
  registry?: Record<string, unknown>,
): IPaypalCaptureTrigger | null => getPaypalCaptureRuntime(registry)?.scheduler ?? null;
