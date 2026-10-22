import { err, ok, Result } from "neverthrow";

import {
  AppIsNotConfiguredResponse,
  BrokenAppResponse,
} from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import { appContextContainer } from "@/lib/app-context";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { PaymentFeeGateConfig } from "@/modules/payment-fee-gate/payment-fee-gate-config";
import { SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  PaymentGatewayInitializeSessionUseCaseResponses,
  PaymentGatewayInitializeSessionUseCaseResponsesType,
} from "./use-case-response";

export class PaymentGatewayInitializeSessionUseCase {
  private appConfigRepo: AppConfigRepo;
  private paymentFeeGate: PaymentFeeGateConfig | null;
  private logger = createLogger("PaymentGatewayInitializeSessionUseCase");

  static UseCaseError = BaseError.subclass("PaymentGatewayInitializeSessionUseCaseError", {
    props: {
      _internalName: "InitializeStripeSessionUseCaseError" as const,
    },
  });

  constructor(deps: {
    appConfigRepo: AppConfigRepo;
    /** PayPal-fee hard gate (A3c). Absent or null: nothing is advertised. */
    paymentFeeGate?: PaymentFeeGateConfig | null;
  }) {
    this.appConfigRepo = deps.appConfigRepo;
    this.paymentFeeGate = deps.paymentFeeGate ?? null;
  }

  async execute(params: {
    channelId: string;
    appId: string;
    saleorApiUrl: SaleorApiUrl;
  }): Promise<
    Result<
      PaymentGatewayInitializeSessionUseCaseResponsesType,
      AppIsNotConfiguredResponse | BrokenAppResponse
    >
  > {
    const { channelId, appId, saleorApiUrl } = params;

    const stripeConfigForThisChannel = await this.appConfigRepo.getStripeConfig({
      channelId,
      appId,
      saleorApiUrl,
    });

    if (stripeConfigForThisChannel.isOk()) {
      const pk = stripeConfigForThisChannel.value?.publishableKey;

      if (!pk) {
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

      return ok(
        new PaymentGatewayInitializeSessionUseCaseResponses.Success({
          pk,
          appContext: appContextContainer.getContextValue(),
          // A3c §1b: the capability handshake. This call writes nothing in Stripe.
          paymentFeeGate: this.paymentFeeGate
            ? { method: this.paymentFeeGate.method, ratePercent: this.paymentFeeGate.ratePercent }
            : null,
        }),
      );
    }

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

    throw new PaymentGatewayInitializeSessionUseCase.UseCaseError("Leaky logic, should not happen");
  }
}
