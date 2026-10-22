import { err, ok } from "neverthrow";
import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { mockedSaleorTransactionId } from "@/__tests__/mocks/constants";
import { getMockedRecordedTransaction } from "@/__tests__/mocks/mocked-recorded-transaction";
import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { mockedStripeRefundId } from "@/__tests__/mocks/mocked-stripe-refund-id";
import { MockedTransactionRecorder } from "@/__tests__/mocks/mocked-transaction-recorder";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { getMockedChargeRefundUpdatedEvent } from "@/__tests__/mocks/stripe-events/mocked-charge-refund-updated";
import { getMockedRefundCreatedEvent } from "@/__tests__/mocks/stripe-events/mocked-refund-created";
import { createResolvedTransactionFlow } from "@/modules/resolved-transaction-flow";
import {
  FetchedTransactionEvent,
  ITransactionEventsFetcher,
  TransactionEventsFetcherErrors,
} from "@/modules/saleor/transaction-events-fetcher";
import { generateRefundStripeDashboardUrl } from "@/modules/stripe/generate-stripe-dashboard-urls";
import { createStripeRefundId } from "@/modules/stripe/stripe-refund-id";
import { TransactionRecorderError } from "@/modules/transactions-recording/repositories/transaction-recorder-repo";

import { StripeRefundHandler } from "./stripe-refund-handler";

/** What Saleor holds on the transaction; created per test (vitest mockReset). */
const eventsFetcher = (events: ReadonlyArray<FetchedTransactionEvent> | null = []) =>
  ({
    fetchTransactionEvents: vi.fn(async () => ok(events)),
  }) satisfies ITransactionEventsFetcher;

const recorderWithTransaction = () => {
  const mockTransactionRecorder = new MockedTransactionRecorder();

  mockTransactionRecorder.transactions = {
    [mockedStripePaymentIntentId]: getMockedRecordedTransaction(),
  };

  return mockTransactionRecorder;
};

const isoAt = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

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
        transactionEventsFetcher: eventsFetcher(),
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
            transactionEventsFetcher: eventsFetcher(),
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
           * A2e: each refund under its own Stripe refund id. Saleor de-duplicates events by
           * (pspReference, type) and counts one REFUND_SUCCESS per pspReference.
           */
          expect(pspReference).toStrictEqual(event.data.object.id);
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

        const handler = new StripeRefundHandler();

        const result = await handler.processRefundEvent({
          event,
          transactionRecorder: recorderWithTransaction(),
          transactionEventsFetcher: eventsFetcher(),
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

        const handler = new StripeRefundHandler();

        const result = await handler.processRefundEvent({
          event,
          transactionRecorder: recorderWithTransaction(),
          // A refund Saleor recorded under the PaymentIntent before A2e keeps that reference.
          transactionEventsFetcher: eventsFetcher([
            {
              type: "REFUND_SUCCESS",
              pspReference: mockedStripePaymentIntentId,
              externalUrl: generateRefundStripeDashboardUrl(mockedStripeRefundId, "LIVE"),
              createdAt: "2025-02-01T00:00:05Z",
              amount: { amount: 10, currency: "USD" },
            },
          ]),
          appId: "appId",
          saleorApiUrl: mockedSaleorApiUrl,
          stripeEnv: "LIVE",
        });

        const { pspReference } = result._unsafeUnwrap().resolveEventReportVariables();

        // The payment_intent object form is resolved to its id.
        expect(pspReference).toStrictEqual(mockedStripePaymentIntentId);
      });
    });

    describe("refunds created outside of Saleor", () => {
      const setup = () => ({
        mockTransactionRecorder: recorderWithTransaction(),
        handler: new StripeRefundHandler(),
      });

      it("should report a Stripe Dashboard refund under the refund ID, so several external refunds of one intent stay distinct", async () => {
        const { mockTransactionRecorder, handler } = setup();
        const event = getMockedRefundCreatedEvent();
        const fetcher = eventsFetcher();

        const result = await handler.processRefundEvent({
          event,
          transactionRecorder: mockTransactionRecorder,
          transactionEventsFetcher: fetcher,
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
        // Always reported under the refund id, before A2e too: nothing to look up in Saleor.
        expect(fetcher.fetchTransactionEvents).not.toHaveBeenCalled();
      });

      it("should report REFUND_FAILURE for a failed external refund", async () => {
        const { mockTransactionRecorder, handler } = setup();
        const event = getMockedRefundCreatedEvent({ status: "failed" });

        const result = await handler.processRefundEvent({
          event,
          transactionRecorder: mockTransactionRecorder,
          transactionEventsFetcher: eventsFetcher(),
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
          transactionEventsFetcher: eventsFetcher(),
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
          transactionEventsFetcher: eventsFetcher(),
          appId: "appId",
          saleorApiUrl: mockedSaleorApiUrl,
          stripeEnv: "LIVE",
        });

        expect(result._unsafeUnwrapErr()).toBeInstanceOf(
          TransactionRecorderError.TransactionMissingError,
        );
      });
    });

    /*
     * A2e (a): Saleor 3.22.74 de-duplicates transaction events by (pspReference, type)
     * (payment/utils.py get_already_existing_event) and counts only the latest REFUND_SUCCESS
     * per pspReference (transaction_item_calculations.py). Under the PaymentIntent a second
     * refund of one payment was dropped (same amount) or rejected (other amount).
     */
    describe("refunds the app created (A2e)", () => {
      /** 2025-02-01T00:00:00Z: `created` of the mocked refunds. */
      const REFUND_CREATED = new Date(2025, 1, 1).getTime() / 1000;

      const appRefundEvent = (
        type: "refund.created" | "refund.updated" | "refund.failed",
        overrides: { id?: string; status?: Stripe.Refund["status"] } = {},
      ) => {
        const event = getMockedRefundCreatedEvent({
          createdBySaleor: true,
          status: overrides.status,
        });

        return {
          ...event,
          type,
          data: {
            object: { ...event.data.object, id: overrides.id ?? event.data.object.id },
          },
        } as Stripe.RefundCreatedEvent;
      };

      const process = (event: Stripe.Event, fetcher: ITransactionEventsFetcher) =>
        new StripeRefundHandler().processRefundEvent({
          event,
          transactionRecorder: recorderWithTransaction(),
          transactionEventsFetcher: fetcher,
          appId: "appId",
          saleorApiUrl: mockedSaleorApiUrl,
          stripeEnv: "LIVE",
        });

      const reported = async (event: Stripe.Event, fetcher: ITransactionEventsFetcher) =>
        (await process(event, fetcher))._unsafeUnwrap().resolveEventReportVariables();

      /** How the handler reported an app-created refund before A2e. */
      const recordedUnderPaymentIntent = (
        type: FetchedTransactionEvent["type"],
        refundId = mockedStripeRefundId,
      ): FetchedTransactionEvent => ({
        type,
        pspReference: mockedStripePaymentIntentId,
        externalUrl: generateRefundStripeDashboardUrl(refundId, "LIVE"),
        createdAt: isoAt(REFUND_CREATED + 1),
        amount: { amount: 10, currency: "USD" },
      });

      it("reports a refund the app created under its own Stripe refund id, after reading the transaction's events", async () => {
        const fetcher = eventsFetcher([]);

        const { type, pspReference } = await reported(appRefundEvent("refund.created"), fetcher);

        expect(type).toBe("REFUND_SUCCESS");
        expect(pspReference).toBe(mockedStripeRefundId);
        expect(fetcher.fetchTransactionEvents).toHaveBeenCalledExactlyOnceWith({
          transactionId: mockedSaleorTransactionId,
        });
      });

      it("gives two granted refunds on one PaymentIntent two distinct pspReferences", async () => {
        const first = await reported(
          appRefundEvent("refund.created", { id: "re_FIRST" }),
          eventsFetcher([
            {
              type: "REFUND_REQUEST",
              pspReference: "re_FIRST",
              externalUrl: "",
              createdAt: isoAt(REFUND_CREATED - 1),
              amount: { amount: 10, currency: "USD" },
            },
          ]),
        );
        const second = await reported(
          appRefundEvent("refund.created", { id: "re_SECOND" }),
          eventsFetcher([
            {
              type: "REFUND_REQUEST",
              pspReference: "re_FIRST",
              externalUrl: "",
              createdAt: isoAt(REFUND_CREATED - 1),
              amount: { amount: 10, currency: "USD" },
            },
            {
              type: "REFUND_SUCCESS",
              pspReference: "re_FIRST",
              externalUrl: generateRefundStripeDashboardUrl(createStripeRefundId("re_FIRST"), "LIVE"),
              createdAt: isoAt(REFUND_CREATED),
              amount: { amount: 10, currency: "USD" },
            },
            {
              type: "REFUND_REQUEST",
              pspReference: "re_SECOND",
              externalUrl: "",
              createdAt: isoAt(REFUND_CREATED - 1),
              amount: { amount: 10, currency: "USD" },
            },
          ]),
        );

        expect(first.pspReference).toBe("re_FIRST");
        expect(second.pspReference).toBe("re_SECOND");
      });

      it("reports a failed refund (refund.failed) under its own id, so it cancels that refund only", async () => {
        const { type, pspReference } = await reported(
          appRefundEvent("refund.failed", { status: "failed" }),
          eventsFetcher([
            {
              type: "REFUND_SUCCESS",
              pspReference: mockedStripeRefundId,
              externalUrl: generateRefundStripeDashboardUrl(mockedStripeRefundId, "LIVE"),
              createdAt: isoAt(REFUND_CREATED),
              amount: { amount: 10, currency: "USD" },
            },
          ]),
        );

        expect(type).toBe("REFUND_FAILURE");
        expect(pspReference).toBe(mockedStripeRefundId);
      });

      it("reports under its own id when Saleor has no such transaction", async () => {
        const { pspReference } = await reported(appRefundEvent("refund.updated"), eventsFetcher(null));

        expect(pspReference).toBe(mockedStripeRefundId);
      });

      it("fails (Stripe retries the webhook) when Saleor's events cannot be read", async () => {
        const fetcher = {
          fetchTransactionEvents: vi.fn(async () =>
            err(new TransactionEventsFetcherErrors.FetchError("Saleor unreachable")),
          ),
        } satisfies ITransactionEventsFetcher;

        const result = await process(appRefundEvent("refund.updated"), fetcher);

        expect(result._unsafeUnwrapErr()).toBeInstanceOf(TransactionEventsFetcherErrors.FetchError);
      });

      /*
       * A2e round 2 (P1): Saleor links a refund report to its granted refund only through the
       * REFUND_REQUEST that already carries the same pspReference when the report arrives
       * (transaction_event_report.py get_related_granted_refund). If the Stripe event comes
       * before Saleor tagged its request with the re_ id (the app answered 503 and Saleor
       * retries 10-310 s later, or the event simply beat the answer), a report now stays
       * unlinked and the granted refund stays PENDING for good. Such a report is deferred:
       * Stripe re-sends the event later.
       */
      describe("before Saleor tagged its refund request with the refund id (round 2, P1)", () => {
        const secondsAgo = (seconds: number) => Math.floor(Date.now() / 1000) - seconds;

        const youngAppRefundEvent = (
          type: "refund.created" | "refund.updated" | "refund.failed",
          createdSecondsAgo: number,
          status: Stripe.Refund["status"] = "succeeded",
        ) => {
          const event = appRefundEvent(type, { status });

          event.data.object.created = secondsAgo(createdSecondsAgo);

          return event;
        };

        /** Saleor's REFUND_REQUEST for the granted refund, still without a pspReference. */
        const untaggedRequest: FetchedTransactionEvent = {
          type: "REFUND_REQUEST",
          pspReference: "",
          externalUrl: "",
          createdAt: isoAt(secondsAgo(20)),
          amount: { amount: 10, currency: "USD" },
        };

        const taggedRequest: FetchedTransactionEvent = {
          ...untaggedRequest,
          pspReference: mockedStripeRefundId,
        };

        it.each(["refund.created", "refund.updated", "refund.failed"] as const)(
          "asks Stripe to re-send %s (retryable error) while the request is not tagged",
          async (type) => {
            const result = await process(
              youngAppRefundEvent(type, 15, type === "refund.failed" ? "failed" : "succeeded"),
              eventsFetcher([untaggedRequest]),
            );

            expect(result._unsafeUnwrapErr()).toBeInstanceOf(
              StripeRefundHandler.RefundRequestNotTaggedYetError,
            );
          },
        );

        it("reports under the refund id once the request carries it, so Saleor links it", async () => {
          const { type, pspReference } = await reported(
            youngAppRefundEvent("refund.created", 15),
            eventsFetcher([taggedRequest]),
          );

          expect(type).toBe("REFUND_SUCCESS");
          expect(pspReference).toBe(mockedStripeRefundId);
        });

        it("reports a failed refund once its request is tagged", async () => {
          const { type, pspReference } = await reported(
            youngAppRefundEvent("refund.failed", 15, "failed"),
            eventsFetcher([taggedRequest]),
          );

          expect(type).toBe("REFUND_FAILURE");
          expect(pspReference).toBe(mockedStripeRefundId);
        });

        it("stops deferring once Saleor's retries are over, so the refund is never dropped", async () => {
          const { pspReference } = await reported(
            youngAppRefundEvent("refund.created", 11 * 60),
            eventsFetcher([untaggedRequest]),
          );

          expect(pspReference).toBe(mockedStripeRefundId);
        });

        it("does not defer a Dashboard refund (no Saleor request to wait for)", async () => {
          const event = getMockedRefundCreatedEvent();

          event.data.object.created = secondsAgo(5);

          const fetcher = eventsFetcher([untaggedRequest]);
          const { pspReference } = await reported(event, fetcher);

          expect(pspReference).toBe(mockedStripeRefundId);
          expect(fetcher.fetchTransactionEvents).not.toHaveBeenCalled();
        });

        it("does not defer a refund kept under the PaymentIntent (recorded there before A2e)", async () => {
          const { pspReference } = await reported(
            youngAppRefundEvent("refund.updated", 15),
            eventsFetcher([recordedUnderPaymentIntent("REFUND_SUCCESS")]),
          );

          expect(pspReference).toBe(mockedStripePaymentIntentId);
        });

        it("does not defer when Saleor has no such transaction (nothing to wait for)", async () => {
          const { pspReference } = await reported(
            youngAppRefundEvent("refund.created", 15),
            eventsFetcher(null),
          );

          expect(pspReference).toBe(mockedStripeRefundId);
        });
      });

      /*
       * A2e round 3: Saleor's granted refund status is its newest related event by created_at
       * (order/utils.py calculate_order_granted_refund_status), the report's `time`. Stripe
       * times are whole seconds; Saleor's REFUND_REQUEST has microseconds. A success in the
       * same second as the request sorted before it and left the granted refund PENDING.
       */
      describe("report time after the tagged refund request (round 3)", () => {
        /** Saleor's REFUND_REQUEST, tagged with the refund id, created at 14:42:13.969132. */
        const REQUEST_CREATED_AT = "2026-10-22T14:42:13.969132+00:00";
        const SAME_SECOND = Date.UTC(2026, 9, 22, 14, 42, 13) / 1000;

        const taggedRequest: FetchedTransactionEvent = {
          type: "REFUND_REQUEST",
          pspReference: mockedStripeRefundId,
          externalUrl: "",
          createdAt: REQUEST_CREATED_AT,
          amount: { amount: 10, currency: "USD" },
        };

        const appRefundEventAt = (
          type: "refund.created" | "refund.updated" | "refund.failed",
          eventCreated: number,
          status: Stripe.Refund["status"],
        ) => {
          const event = appRefundEvent(type, { status });

          event.created = eventCreated;
          event.data.object.created = SAME_SECOND;

          return event;
        };

        it.each([
          { type: "refund.created" as const, status: "succeeded" as const, result: "REFUND_SUCCESS" },
          { type: "refund.created" as const, status: "pending" as const, result: "REFUND_REQUEST" },
          { type: "refund.failed" as const, status: "failed" as const, result: "REFUND_FAILURE" },
        ])(
          "reports $result 1 ms after the request when Stripe's event is in the request's second",
          async ({ type, status, result }) => {
            const reportedEvent = await reported(
              appRefundEventAt(type, SAME_SECOND, status),
              eventsFetcher([taggedRequest]),
            );

            expect(reportedEvent.type).toBe(result);
            expect(reportedEvent.time).toBe("2026-10-22T14:42:13.970Z");
          },
        );

        it("keeps Stripe's event time when it is in a later second", async () => {
          const { time } = await reported(
            appRefundEventAt("refund.created", SAME_SECOND + 3, "succeeded"),
            eventsFetcher([taggedRequest]),
          );

          expect(time).toBe("2026-10-22T14:42:16.000Z");
        });

        it("keeps Stripe's event time for a refund kept under the PaymentIntent (recorded before A2e)", async () => {
          const { pspReference, time } = await reported(
            appRefundEventAt("refund.updated", SAME_SECOND, "succeeded"),
            eventsFetcher([
              { ...recordedUnderPaymentIntent("REFUND_SUCCESS"), createdAt: REQUEST_CREATED_AT },
              { ...taggedRequest, pspReference: mockedStripePaymentIntentId },
            ]),
          );

          expect(pspReference).toBe(mockedStripePaymentIntentId);
          expect(time).toBe("2026-10-22T14:42:13.000Z");
        });

        it("keeps Stripe's event time for a Dashboard refund (no Saleor request)", async () => {
          const event = getMockedRefundCreatedEvent();

          event.created = SAME_SECOND;

          const { time } = await reported(event, eventsFetcher([taggedRequest]));

          expect(time).toBe("2026-10-22T14:42:13.000Z");
        });
      });

      /*
       * Compatibility: refunds Saleor recorded BEFORE A2e are counted in the PaymentIntent's
       * group. A later Stripe event for one of them must stay in that group: under the re_ id a
       * REFUND_SUCCESS would count the refund twice and a REFUND_FAILURE would cancel nothing.
       */
      describe("a later Stripe event for a refund Saleor recorded under the PaymentIntent", () => {
        it.each([
          { type: "refund.updated" as const, status: "succeeded" as const, expected: "REFUND_SUCCESS" },
          { type: "refund.failed" as const, status: "failed" as const, expected: "REFUND_FAILURE" },
        ])(
          "stays under the PaymentIntent ($type, $status)",
          async ({ type, status, expected }) => {
            const result = await reported(
              appRefundEvent(type, { status }),
              eventsFetcher([
                recordedUnderPaymentIntent("REFUND_REQUEST", mockedStripeRefundId),
                recordedUnderPaymentIntent("REFUND_SUCCESS"),
              ]),
            );

            expect(result.type).toBe(expected);
            expect(result.pspReference).toBe(mockedStripePaymentIntentId);
          },
        );

        it("stays under the PaymentIntent when only its request is recorded there (same amount, made seconds before)", async () => {
          const { pspReference } = await reported(
            appRefundEvent("refund.updated"),
            eventsFetcher([
              {
                type: "REFUND_REQUEST",
                pspReference: mockedStripePaymentIntentId,
                externalUrl: "",
                createdAt: isoAt(REFUND_CREATED - 3),
                amount: { amount: 10, currency: "USD" },
              },
            ]),
          );

          expect(pspReference).toBe(mockedStripePaymentIntentId);
        });

        it("does not take a new refund of the same amount for the old one", async () => {
          const { pspReference } = await reported(
            appRefundEvent("refund.created", { id: "re_NEW_REFUND" }),
            eventsFetcher([
              {
                type: "REFUND_REQUEST",
                pspReference: mockedStripePaymentIntentId,
                externalUrl: "",
                createdAt: isoAt(REFUND_CREATED - 5 * 86400),
                amount: { amount: 10, currency: "USD" },
              },
              {
                ...recordedUnderPaymentIntent("REFUND_SUCCESS"),
                createdAt: isoAt(REFUND_CREATED - 5 * 86400 + 2),
              },
            ]),
          );

          expect(pspReference).toBe("re_NEW_REFUND");
        });
      });
    });
  });
});
