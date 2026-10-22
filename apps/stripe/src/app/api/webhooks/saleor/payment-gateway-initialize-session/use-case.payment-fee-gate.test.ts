import { ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockedSaleorAppId, mockedSaleorChannelId } from "@/__tests__/mocks/constants";
import { mockedStripePublishableKey } from "@/__tests__/mocks/mocked-stripe-publishable-key";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { AppIsNotConfiguredResponse } from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import { PaymentFeeGateConfig } from "@/modules/payment-fee-gate/payment-fee-gate-config";

import { PaymentGatewayInitializeSessionUseCase } from "./use-case";
import { PaymentGatewayInitializeSessionUseCaseResponses } from "./use-case-response";

/*
 * A3c §1b: the capability handshake. The storefront shows the PayPal choice only when the app
 * advertises the gate; gate off, the response is exactly today's `{ stripePublishableKey }`.
 */

const GATE: PaymentFeeGateConfig = {
  method: "paypal",
  ratePercent: 1.5,
  variantId: "UHJvZHVjdFZhcmlhbnQ6NDQ5",
  metadataKey: "payment_fee_type",
};

const execute = (paymentFeeGate?: PaymentFeeGateConfig | null) =>
  new PaymentGatewayInitializeSessionUseCase({
    appConfigRepo: mockedAppConfigRepo,
    ...(paymentFeeGate === undefined ? {} : { paymentFeeGate }),
  }).execute({
    channelId: mockedSaleorChannelId,
    saleorApiUrl: mockedSaleorApiUrl,
    appId: mockedSaleorAppId,
  });

describe("PaymentGatewayInitializeSessionUseCase: PayPal-fee gate advertisement (A3c)", () => {
  it("advertises the gate with its method and rate, and nothing else (no variant ID)", async () => {
    const response = (await execute(GATE))._unsafeUnwrap();

    expect(await response.getResponse().json()).toStrictEqual({
      data: {
        stripePublishableKey: mockedStripePublishableKey,
        paymentFeeGate: { method: "paypal", ratePercent: 1.5 },
      },
    });
  });

  it.each([undefined, null])("returns exactly today's data with the gate off (%s)", async (gate) => {
    const response = (await execute(gate))._unsafeUnwrap();

    expect(await response.getResponse().json()).toStrictEqual({
      data: { stripePublishableKey: mockedStripePublishableKey },
    });
  });

  it("advertises nothing when the channel has no Stripe configuration", async () => {
    vi.spyOn(mockedAppConfigRepo, "getStripeConfig").mockImplementationOnce(async () => ok(null));

    expect((await execute(GATE))._unsafeUnwrapErr()).toBeInstanceOf(AppIsNotConfiguredResponse);
  });

  it("serializes the advertisement in the Success response", async () => {
    const response = new PaymentGatewayInitializeSessionUseCaseResponses.Success({
      pk: mockedStripePublishableKey,
      appContext: { stripeEnv: "LIVE" },
      paymentFeeGate: { method: "paypal", ratePercent: 2 },
    });

    expect(await response.getResponse().json()).toStrictEqual({
      data: {
        stripePublishableKey: "pk_live_1",
        paymentFeeGate: { method: "paypal", ratePercent: 2 },
      },
    });
  });
});
