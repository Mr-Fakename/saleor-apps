import { APL } from "@saleor/app-sdk/APL";
import { ok } from "neverthrow";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockedSaleorChannelId } from "@/__tests__/mocks/constants";
import { mockAuthData } from "@/__tests__/mocks/mock-auth-data";
import { mockedStripePaymentIntentsApi } from "@/__tests__/mocks/mocked-stripe-payment-intents-api";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { PaymentFeeGateConfig } from "@/modules/payment-fee-gate/payment-fee-gate-config";
import { PaypalCaptureMode } from "@/modules/payment-fee-gate/paypal-capture-config";
import { CheckoutPaymentStateWithLines, ICheckoutPaymentStateFetcher } from "@/modules/saleor/checkout-payment-state-fetcher";
import { IStripePaymentIntentsApiFactory } from "@/modules/stripe/types";

import { UpdatePaymentIntentAmountUseCase, UpdatePaymentIntentErrors } from "./use-case";

/*
 * A3d on /api/update-payment-intent: with manual PayPal capture on, a paypal-only PaymentIntent
 * created without it (before the deploy, or while the kill switch was on) must not get a new
 * amount: Stripe would capture it at approval, before the app checked the order. It is refused
 * with PAYMENT_POLICY_REINIT, which the storefront already answers by initializing again.
 */

const CHECKOUT_ID = "Q2hlY2tvdXQ6MQ==";
const TRANSACTION_ID = "VHJhbnNhY3Rpb25JdGVtOjE=";
const PAYMENT_INTENT_ID = "pi_3CaptureMode";
const FEE_VARIANT_ID = "UHJvZHVjdFZhcmlhbnQ6NDQ5";

const GATE: PaymentFeeGateConfig = {
  method: "paypal",
  ratePercent: 1.5,
  variantId: FEE_VARIANT_ID,
  metadataKey: "payment_fee_type",
};

const eur = (amount: number) => ({ amount, currency: "EUR" });

const checkout: CheckoutPaymentStateWithLines = {
  id: CHECKOUT_ID,
  channel: { id: mockedSaleorChannelId },
  totalPrice: { gross: eur(213.15) },
  transactions: [
    {
      id: TRANSACTION_ID,
      pspReference: PAYMENT_INTENT_ID,
      chargedAmount: eur(0),
      authorizedAmount: eur(0),
      chargePendingAmount: eur(0),
      authorizePendingAmount: eur(0),
      refundedAmount: eur(0),
      refundPendingAmount: eur(0),
      canceledAmount: eur(0),
      cancelPendingAmount: eur(0),
      events: [],
    },
  ],
  lines: [
    { id: "Q2hlY2tvdXRMaW5lOjE=", quantity: 1, variant: { id: "UHJvZHVjdFZhcmlhbnQ6MTI=" }, metadata: [], totalPrice: { gross: eur(210) } },
    {
      id: "Q2hlY2tvdXRMaW5lOjI=",
      quantity: 1,
      variant: { id: FEE_VARIANT_ID },
      metadata: [{ key: "payment_fee_type", value: "paypal_1.5_percent" }],
      totalPrice: { gross: eur(3.15) },
    },
  ],
};

const paypalOnly = (capture: "manual" | "automatic") =>
  ({
    id: PAYMENT_INTENT_ID,
    object: "payment_intent",
    amount: 200_00,
    currency: "eur",
    status: "requires_payment_method",
    client_secret: `${PAYMENT_INTENT_ID}_secret_test`,
    payment_method_types: ["paypal"],
    excluded_payment_method_types: null,
    automatic_payment_methods: null,
    capture_method: "automatic_async",
    payment_method_options: { paypal: capture === "manual" ? { capture_method: "manual" } : {} },
    metadata: {
      saleor_source_id: CHECKOUT_ID,
      saleor_source_type: "Checkout",
      saleor_transaction_id: TRANSACTION_ID,
      saleor_payment_policy: "paypal-only",
    },
  }) as unknown as Stripe.PaymentIntent;

const mockApl = { get: vi.fn() } satisfies Pick<APL, "get">;
const mockCheckoutFetcher = { fetchCheckoutPaymentState: vi.fn() } satisfies ICheckoutPaymentStateFetcher;
const stripePaymentIntentsApiFactory = { create: () => mockedStripePaymentIntentsApi } satisfies IStripePaymentIntentsApiFactory;

const execute = (args: { gate?: PaymentFeeGateConfig | null; paypalCapture?: PaypalCaptureMode | null }) =>
  new UpdatePaymentIntentAmountUseCase({
    apl: mockApl,
    appConfigRepo: mockedAppConfigRepo,
    stripePaymentIntentsApiFactory,
    checkoutPaymentStateFetcherFactory: () => mockCheckoutFetcher,
    ...(args.gate === undefined ? {} : { paymentFeeGate: args.gate }),
    ...(args.paypalCapture === undefined ? {} : { paypalCapture: args.paypalCapture }),
  }).execute({
    paymentIntentId: PAYMENT_INTENT_ID,
    amount: 213.15,
    currency: "EUR",
    channelId: mockedSaleorChannelId,
    saleorApiUrl: mockedSaleorApiUrl,
  });

const getMock = () => vi.mocked(mockedStripePaymentIntentsApi.getPaymentIntent);
const updateMock = () => vi.mocked(mockedStripePaymentIntentsApi.updatePaymentIntent);

describe("UpdatePaymentIntentAmountUseCase: A3d PayPal capture mode", () => {
  beforeEach(() => {
    mockApl.get.mockResolvedValue(mockAuthData);
    mockCheckoutFetcher.fetchCheckoutPaymentState.mockResolvedValue(ok(checkout));
    updateMock().mockImplementation(async (args) => ok({ ...paypalOnly("manual"), amount: args.stripeMoney.amount }));
  });

  it("refuses PAYMENT_POLICY_REINIT for an automatic paypal-only PaymentIntent with manual capture on", async () => {
    getMock().mockResolvedValue(ok(paypalOnly("automatic")));

    const error = (await execute({ gate: GATE, paypalCapture: "manual" }))._unsafeUnwrapErr();

    expect(error).toBeInstanceOf(UpdatePaymentIntentErrors.PaymentPolicyConflictError);
    expect(error instanceof UpdatePaymentIntentErrors.PaymentPolicyConflictError && error.code).toBe(
      "PAYMENT_POLICY_REINIT",
    );
    expect(updateMock()).not.toHaveBeenCalled();
  });

  it("updates a manual paypal-only PaymentIntent with manual capture on", async () => {
    getMock().mockResolvedValue(ok(paypalOnly("manual")));

    const result = await execute({ gate: GATE, paypalCapture: "manual" });

    expect(result._unsafeUnwrap()).toStrictEqual({
      paymentIntentId: PAYMENT_INTENT_ID,
      amount: 213_15,
      currency: "eur",
      updated: true,
    });
  });

  it.each([
    { paypalCapture: undefined, capture: "automatic" as const },
    { paypalCapture: null, capture: "automatic" as const },
    { paypalCapture: "automatic" as const, capture: "automatic" as const },
    { paypalCapture: "automatic" as const, capture: "manual" as const },
  ])(
    "updates a $capture paypal-only PaymentIntent when the capture mode is $paypalCapture (the gate before A3d)",
    async ({ paypalCapture, capture }) => {
      getMock().mockResolvedValue(ok(paypalOnly(capture)));

      const result = await execute({ gate: GATE, paypalCapture });

      expect(result._unsafeUnwrap().updated).toBe(true);
    },
  );

  it("gate off: today's update whatever the capture mode", async () => {
    getMock().mockResolvedValue(ok(paypalOnly("automatic")));

    const result = await execute({ gate: null, paypalCapture: "manual" });

    expect(result._unsafeUnwrap().updated).toBe(true);
    expect(mockCheckoutFetcher.fetchCheckoutPaymentState.mock.calls).toStrictEqual([[{ checkoutId: CHECKOUT_ID }]]);
  });
});
