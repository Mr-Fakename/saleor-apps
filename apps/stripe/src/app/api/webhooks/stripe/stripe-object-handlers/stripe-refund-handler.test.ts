import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { getMockedRecordedTransaction } from "@/__tests__/mocks/mocked-recorded-transaction";
import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { MockedTransactionRecorder } from "@/__tests__/mocks/mocked-transaction-recorder";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { getMockedChargeRefundUpdatedEvent } from "@/__tests__/mocks/stripe-events/mocked-charge-refund-updated";
import { getMockedRefundCreatedEvent } from "@/__tests__/mocks/stripe-events/mocked-refund-created";
import { createResolvedTransactionFlow } from "@/modules/resolved-transaction-flow";
import { TransactionRecorderError } from "@/modules/transactions-recording/repositories/transaction-recorder-repo";

import { StripeRefundHandler } from "./stripe-refund-handler";

describe("StripeRefundHandler", () => {
  describe("processRefundEvent", () => {
    it("should return NotSupportedEventError for unsupported event", async () => {
      const mockTransactionRecorder = new MockedTransactionRecorder();
      const event = {
        type: "charge.refunded",
      } as unknown as Stripe.Event;

      const handler = new StripeRefundHandler();

      const result = await handler.processRefundEvent({
        event,
        stripeEnv: "LIVE",
        transactionRecorder: mockTransactionRecorder,
        appId: "appId",
        saleorApiUrl: mockedSaleorApiUrl,
      });

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(StripeRefundHandler.NotSupportedEventError);
    });

    describe("charge.refund.updated", () => {
      it.each([
        createResolvedTransactionFlow("AUTHORIZATION"),
        createResolvedTransactionFlow("CHARGE"),
      ])(
        "should resolve fields from Stripe event properly for '%s' flow",
        async (resolvedTransactionFlow) => {
          const event = getMockedChargeRefundUpdatedEvent();
          const mockTransactionRecorder = new MockedTransactionRecorder();

          mockTransactionRecorder.transactions = {
            [mockedStripePaymentIntentId]: getMockedRecordedTransaction({
              resolvedTransactionFlow,
            }),
          };

          const amountToUse = 123_30;
          const amountExpected = 123.3; // Converted to Saleor float

          event.data.object.amount = amountToUse;

          const handler = new StripeRefundHandler();

          const result = await handler.processRefundEvent({
            event,
            transactionRecorder: mockTransactionRecorder,
            appId: "appId",
            saleorApiUrl: mockedSaleorApiUrl,
            stripeEnv: "LIVE",
          });

          const { type, amount, pspReference, time } = result
            ._unsafeUnwrap()
            .resolveEventReportVariables();

          expect(type).toBe("REFUND_SUCCESS");
          // comes from mock
          expect(amount.currency).toStrictEqual("USD");
          expect(amount.amount).toStrictEqual(amountExpected);
          /*
           * pspReference is intentionally the Payment Intent ID (not the refund ID)
           * so that all transaction events for the same transaction share one pspReference.
           */
          expect(pspReference).toStrictEqual(event.data.object.payment_intent);
          expect(time).toStrictEqual("2025-02-01T00:00:00.000Z");
        },
      );

      it("should return MalformedEventError if event does not contain payment_intent", async () => {
        const event = {
          ...getMockedChargeRefundUpdatedEvent(),
          data: {
            object: {
              payment_intent: null,
            },
          },
        } as unknown as Stripe.ChargeRefundUpdatedEvent;

        const mockTransactionRecorder = new MockedTransactionRecorder();

        mockTransactionRecorder.transactions = {
          [mockedStripePaymentIntentId]: getMockedRecordedTransaction(),
        };

        const handler = new StripeRefundHandler();

        const result = await handler.processRefundEvent({
          event,
          transactionRecorder: mockTransactionRecorder,
          appId: "appId",
          saleorApiUrl: mockedSaleorApiUrl,
          stripeEnv: "LIVE",
        });

        expect(result._unsafeUnwrapErr()).toBeInstanceOf(StripeRefundHandler.MalformedEventError);
      });

      it("should resolve payment_intent from object", async () => {
        const event = {
          ...getMockedChargeRefundUpdatedEvent(),
          data: {
            object: {
              ...getMockedChargeRefundUpdatedEvent().data.object,
              payment_intent: {
                id: mockedStripePaymentIntentId.toString(),
              },
            },
          },
        } as unknown as Stripe.ChargeRefundUpdatedEvent;

        const mockTransactionRecorder = new MockedTransactionRecorder();

        mockTransactionRecorder.transactions = {
          [mockedStripePaymentIntentId]: getMockedRecordedTransaction(),
        };

        const handler = new StripeRefundHandler();

        const result = await handler.processRefundEvent({
          event,
          transactionRecorder: mockTransactionRecorder,
          appId: "appId",
          saleorApiUrl: mockedSaleorApiUrl,
          stripeEnv: "LIVE",
        });

        const { pspReference } = result._unsafeUnwrap().resolveEventReportVariables();

        /*
         * The payment_intent object form is resolved to its id and used as pspReference
         * (intentionally the Payment Intent ID, not the refund ID - see stripe-refund-handler.ts).
         */
        expect(pspReference).toStrictEqual(mockedStripePaymentIntentId);
      });
    });

    describe("refunds created outside of Saleor", () => {
      const setup = () => {
        const mockTransactionRecorder = new MockedTransactionRecorder();

        mockTransactionRecorder.transactions = {
          [mockedStripePaymentIntentId]: getMockedRecordedTransaction(),
        };

        return { mockTransactionRecorder, handler: new StripeRefundHandler() };
      };

      it("should report a Stripe Dashboard refund under the refund ID, so several external refunds of one intent stay distinct", async () => {
        const { mockTransactionRecorder, handler } = setup();
        const event = getMockedRefundCreatedEvent();

        const result = await handler.processRefundEvent({
          event,
          transactionRecorder: mockTransactionRecorder,
          appId: "appId",
          saleorApiUrl: mockedSaleorApiUrl,
          stripeEnv: "LIVE",
        });

        const { type, pspReference, amount } = result
          ._unsafeUnwrap()
          .resolveEventReportVariables();

        expect(type).toBe("REFUND_SUCCESS");
        expect(pspReference).toStrictEqual(event.data.object.id);
        expect(amount.amount).toStrictEqual(10);
      });

      it("should keep the Payment Intent ID when the refund carries Saleor metadata", async () => {
        const { mockTransactionRecorder, handler } = setup();
        const event = getMockedRefundCreatedEvent({ createdBySaleor: true });

        const result = await handler.processRefundEvent({
          event,
          transactionRecorder: mockTransactionRecorder,
          appId: "appId",
          saleorApiUrl: mockedSaleorApiUrl,
          stripeEnv: "LIVE",
        });

        const { pspReference } = result._unsafeUnwrap().resolveEventReportVariables();

        expect(pspReference).toStrictEqual(mockedStripePaymentIntentId);
      });

      it("should report REFUND_FAILURE for a failed external refund", async () => {
        const { mockTransactionRecorder, handler } = setup();
        const event = getMockedRefundCreatedEvent({ status: "failed" });

        const result = await handler.processRefundEvent({
          event,
          transactionRecorder: mockTransactionRecorder,
          appId: "appId",
          saleorApiUrl: mockedSaleorApiUrl,
          stripeEnv: "LIVE",
        });

        expect(result._unsafeUnwrap().resolveEventReportVariables().type).toBe("REFUND_FAILURE");
      });

      it("should return MalformedEventError instead of throwing when the status is unknown", async () => {
        const { mockTransactionRecorder, handler } = setup();
        const event = getMockedRefundCreatedEvent();

        // Stripe types the status as nullable and may add new values
        event.data.object.status = null;

        const result = await handler.processRefundEvent({
          event,
          transactionRecorder: mockTransactionRecorder,
          appId: "appId",
          saleorApiUrl: mockedSaleorApiUrl,
          stripeEnv: "LIVE",
        });

        expect(result._unsafeUnwrapErr()).toBeInstanceOf(StripeRefundHandler.MalformedEventError);
      });

      it("should fail with TransactionMissingError when the payment intent was not recorded by this app", async () => {
        const mockTransactionRecorder = new MockedTransactionRecorder();
        const handler = new StripeRefundHandler();

        const result = await handler.processRefundEvent({
          event: getMockedRefundCreatedEvent(),
          transactionRecorder: mockTransactionRecorder,
          appId: "appId",
          saleorApiUrl: mockedSaleorApiUrl,
          stripeEnv: "LIVE",
        });

        expect(result._unsafeUnwrapErr()).toBeInstanceOf(
          TransactionRecorderError.TransactionMissingError,
        );
      });
    });
  });
});
