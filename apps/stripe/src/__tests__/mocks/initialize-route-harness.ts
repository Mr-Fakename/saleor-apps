import type { AuthData } from "@saleor/app-sdk/APL";
import { NextRequest } from "next/server";
import Stripe from "stripe";

import { mockedAppToken, mockedSaleorAppId, mockedSaleorChannelId, mockedSaleorTransactionId } from "@/__tests__/mocks/constants";
import { createSaleorSigningKeys, signSaleorWebhookBody } from "@/__tests__/mocks/saleor-webhook-signature";
import { CreatePaymentIntentArgs } from "@/modules/stripe/types";

/*
 * Drives the real TRANSACTION_INITIALIZE_SESSION route (SDK SaleorSyncWebhook with a real RS256
 * signature, recipient check, use case), as webhook-signature.test.ts does. The test file mocks
 * the boundaries: APL storage, config repo, transaction recorder, Stripe API, Saleor GraphQL
 * client, env.
 */

export const ROUTE_SALEOR_API_URL = "https://saleor-api.example.test/graphql/";
const APP_HOST = "stripe.example.test";
const CHECKOUT_ID = "Q2hlY2tvdXQ6cm91dGUtdGVzdA==";
export const ROUTE_FEE_VARIANT_ID = "UHJvZHVjdFZhcmlhbnQ6NDQ5";

const saleorKeys = createSaleorSigningKeys("saleor-kid");

export const routeAuthData = (): AuthData => ({
  saleorApiUrl: ROUTE_SALEOR_API_URL,
  appId: mockedSaleorAppId,
  token: mockedAppToken,
  jwks: saleorKeys.jwks,
});

export const signedInitializeRequest = (args: {
  paymentMethod: "paypal" | "card";
  amount: number;
  idempotencyKey: string;
  /** One per request: the route de-duplicates by checkout + transaction + amount + action. */
  transactionId?: string;
}) => {
  const rawBody = JSON.stringify({
    recipient: { id: mockedSaleorAppId },
    action: { amount: args.amount, currency: "EUR", actionType: "CHARGE" },
    transaction: { id: args.transactionId ?? mockedSaleorTransactionId },
    data: { paymentIntent: { paymentMethod: args.paymentMethod } },
    sourceObject: {
      id: CHECKOUT_ID,
      __typename: "Checkout",
      channel: { id: mockedSaleorChannelId, slug: "channel-slug" },
    },
    idempotencyKey: args.idempotencyKey,
  });

  return new NextRequest(`https://${APP_HOST}/api/webhooks/saleor/transaction-initialize-session`, {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      host: APP_HOST,
      "x-forwarded-proto": "https",
      "saleor-api-url": ROUTE_SALEOR_API_URL,
      "saleor-event": "transaction_initialize_session",
      "saleor-signature": signSaleorWebhookBody(rawBody, saleorKeys),
    }),
    body: rawBody,
  });
};

const eur = (amount: number) => ({ amount, currency: "EUR" });

/** The checkout as Saleor answers FetchCheckoutPaymentState(WithLines): base 100.00, fee 1.50. */
export const checkoutQueryResponse = (args: { withFee: boolean }) => ({
  toPromise: async () => ({
    data: {
      checkout: {
        id: CHECKOUT_ID,
        channel: { id: mockedSaleorChannelId },
        totalPrice: { gross: eur(args.withFee ? 101.5 : 100) },
        transactions: [
          {
            id: mockedSaleorTransactionId,
            pspReference: "",
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
          {
            id: "Q2hlY2tvdXRMaW5lOjE=",
            quantity: 1,
            variant: { id: "UHJvZHVjdFZhcmlhbnQ6MTI=" },
            metadata: [],
            totalPrice: { gross: eur(100) },
          },
          ...(args.withFee
            ? [
                {
                  id: "Q2hlY2tvdXRMaW5lOjI=",
                  quantity: 1,
                  variant: { id: ROUTE_FEE_VARIANT_ID },
                  metadata: [{ key: "payment_fee_type", value: "paypal_1.5_percent" }],
                  totalPrice: { gross: eur(1.5) },
                },
              ]
            : []),
        ],
      },
    },
  }),
});

/** Saleor's answer to TransactionUpdate / TransactionUpdateWithPolicy. */
export const transactionUpdateResponse = () => ({
  data: {
    transactionUpdate: {
      errors: [],
      transaction: { id: mockedSaleorTransactionId, pspReference: "pi_route_created" },
    },
  },
});

/** Stripe's answer to the create: the PaymentIntent the params describe. */
export const createdIntentFrom = (args: CreatePaymentIntentArgs): Stripe.PaymentIntent =>
  ({
    id: "pi_route_created",
    object: "payment_intent",
    amount: args.stripeMoney.amount,
    amount_received: 0,
    amount_capturable: 0,
    currency: args.stripeMoney.currency,
    status: "requires_payment_method",
    client_secret: "pi_route_created_secret_test",
    metadata: { ...args.metadata },
    payment_method_types: args.intentParams.payment_method_types ?? ["card"],
    excluded_payment_method_types: args.intentParams.excluded_payment_method_types ?? null,
    automatic_payment_methods: args.intentParams.automatic_payment_methods ? { enabled: true } : null,
    capture_method: "automatic_async",
    payment_method_options: args.intentParams.payment_method_options ?? null,
  }) as Stripe.PaymentIntent;
