import { z } from "zod";

import { SuccessWebhookResponse } from "@/app/api/webhooks/saleor/saleor-webhook-responses";
import { PaymentGatewayInitializeSession } from "@/generated/app-webhooks-types/payment-gateway-initialize-session";
import { AppContext } from "@/lib/app-context";
import { StripePublishableKey } from "@/modules/stripe/stripe-publishable-key";

/**
 * The PayPal-fee gate as advertised to the storefront (A3c §1b): it shows the PayPal choice only
 * when the app sends this. The rate is checkout-prices' rate; the variant ID is not sent.
 */
export type PaymentFeeGateAdvertisement = {
  method: "paypal";
  ratePercent: number;
};

class Success extends SuccessWebhookResponse {
  readonly pk: StripePublishableKey;
  readonly paymentFeeGate: PaymentFeeGateAdvertisement | null;

  private static ResponseDataSchema = z.object({
    stripePublishableKey: z.string(),
  });

  private static ResponseDataWithPaymentFeeGateSchema = z.object({
    stripePublishableKey: z.string(),
    paymentFeeGate: z.object({
      method: z.literal("paypal"),
      ratePercent: z.number().positive().max(100),
    }),
  });

  constructor(args: {
    pk: StripePublishableKey;
    appContext: AppContext;
    paymentFeeGate?: PaymentFeeGateAdvertisement | null;
  }) {
    super(args.appContext);
    this.pk = args.pk;
    this.paymentFeeGate = args.paymentFeeGate ?? null;
  }

  getResponse() {
    const typeSafeResponse: PaymentGatewayInitializeSession = {
      // Gate off: exactly `{ stripePublishableKey }`, as before the gate.
      data: this.paymentFeeGate
        ? Success.ResponseDataWithPaymentFeeGateSchema.parse({
            stripePublishableKey: this.pk,
            paymentFeeGate: this.paymentFeeGate,
          })
        : Success.ResponseDataSchema.parse({
            stripePublishableKey: this.pk,
          }),
    };

    return Response.json(typeSafeResponse, { status: this.statusCode });
  }
}

export const PaymentGatewayInitializeSessionUseCaseResponses = {
  Success,
};

export type PaymentGatewayInitializeSessionUseCaseResponsesType = InstanceType<
  typeof PaymentGatewayInitializeSessionUseCaseResponses.Success
>;
