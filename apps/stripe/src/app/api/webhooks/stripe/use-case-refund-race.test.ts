import { APL } from "@saleor/app-sdk/APL";
import { ok } from "neverthrow";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedAppConfigRepo } from "@/__tests__/mocks/app-config-repo";
import { mockAdyenWebhookUrl } from "@/__tests__/mocks/constants";
import { mockAuthData } from "@/__tests__/mocks/mock-auth-data";
import { getMockedRecordedTransaction } from "@/__tests__/mocks/mocked-recorded-transaction";
import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { mockedStripeRefundId } from "@/__tests__/mocks/mocked-stripe-refund-id";
import { MockedTransactionRecorder } from "@/__tests__/mocks/mocked-transaction-recorder";
import { getMockedRefundCreatedEvent } from "@/__tests__/mocks/stripe-events/mocked-refund-created";
import {
  ITransactionEventReporter,
  TransactionEventReportInput,
} from "@/modules/saleor/transaction-event-reporter";
import {
  FetchedTransactionEvent,
  ITransactionEventsFetcher,
} from "@/modules/saleor/transaction-events-fetcher";
import { StripeWebhookManager } from "@/modules/stripe/stripe-webhook-manager";
import { IStripeEventVerify } from "@/modules/stripe/types";

import { StripeWebhookUseCase } from "./use-case";
import { WebhookParams } from "./webhook-params";

/** Saleor stores created_at with microseconds; compare at that precision. */
const toMicroseconds = (iso: string) => {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/.exec(iso);

  if (!match) {
    throw new Error(`Not an ISO date-time: ${iso}`);
  }

  const wholeSecondsMs = Date.parse(`${match[1]}${match[3]}`);
  const fraction = (match[2] ?? "").padEnd(6, "0").slice(0, 6);

  return wholeSecondsMs * 1000 + Number(fraction);
};

type FakeEvent = { -readonly [K in keyof FetchedTransactionEvent]: FetchedTransactionEvent[K] } & {
  grantedRefundId: string | null;
};

/**
 * The part of Saleor 3.22.74 this race depends on: transactionEventReport links a refund
 * event to the granted refund of the newest REFUND_REQUEST with the same pspReference
 * (transaction_event_report.py get_related_granted_refund, TransactionEvent ordering by pk),
 * at the time of the report, and never later.
 */
class FakeSaleorTransaction {
  events: FakeEvent[];

  constructor(requestCreatedAt = new Date().toISOString()) {
    this.events = [
      {
        type: "CHARGE_SUCCESS",
        pspReference: mockedStripePaymentIntentId,
        externalUrl: "",
        createdAt: new Date().toISOString(),
        amount: { amount: 100, currency: "USD" },
        grantedRefundId: null,
      },
      // transactionRequestRefundForGrantedRefund: the request, before the app's answer.
      {
        type: "REFUND_REQUEST",
        pspReference: "",
        externalUrl: "",
        createdAt: requestCreatedAt,
        amount: { amount: 10, currency: "USD" },
        grantedRefundId: "granted-refund-1",
      },
    ];
  }

  /** payment/utils.py: Saleor copies the pspReference of the app's answer onto its request. */
  tagRequestWith(pspReference: string) {
    const request = this.events.find(
      (event) => event.type === "REFUND_REQUEST" && event.pspReference === "",
    );

    if (request) {
      request.pspReference = pspReference;
    }
  }

  report(input: TransactionEventReportInput) {
    // payment/utils.py get_already_existing_event: same pspReference and type = already processed.
    if (
      this.events.some(
        (event) => event.type === input.type && event.pspReference === input.pspReference,
      )
    ) {
      return;
    }

    const linkedRequest = this.events
      .filter((event) => event.type === "REFUND_REQUEST" && event.pspReference === input.pspReference)
      .at(-1);

    this.events.push({
      type: input.type,
      pspReference: input.pspReference,
      externalUrl: input.externalUrl,
      createdAt: input.time,
      amount: { amount: input.amount.amount, currency: input.amount.currency },
      grantedRefundId: linkedRequest?.grantedRefundId ?? null,
    });
  }

  /**
   * order/utils.py calculate_order_granted_refund_status: the newest related refund event by
   * created_at decides. Saleor has no tie-breaker, so a tie is reported as such.
   */
  grantedRefundStatus(grantedRefundId: string) {
    const related = this.events
      .filter(
        (event) =>
          event.grantedRefundId === grantedRefundId &&
          ["REFUND_REQUEST", "REFUND_SUCCESS", "REFUND_FAILURE"].includes(event.type ?? ""),
      )
      .sort((a, b) => toMicroseconds(a.createdAt) - toMicroseconds(b.createdAt));
    const newest = related.at(-1);
    const previous = related.at(-2);

    if (newest && previous && toMicroseconds(newest.createdAt) === toMicroseconds(previous.createdAt)) {
      return "TIE";
    }

    return { REFUND_REQUEST: "PENDING", REFUND_SUCCESS: "SUCCESS", REFUND_FAILURE: "FAILURE" }[
      newest?.type as "REFUND_REQUEST" | "REFUND_SUCCESS" | "REFUND_FAILURE"
    ];
  }

  /**
   * transaction_item_calculations.py: per pspReference the newest success counts only when it
   * is newer than the newest failure (a tie goes to the failure).
   */
  refundedAmountOf(pspReference: string) {
    const newestOf = (type: string) =>
      this.events
        .filter((event) => event.type === type && event.pspReference === pspReference)
        .sort((a, b) => toMicroseconds(a.createdAt) - toMicroseconds(b.createdAt))
        .at(-1);
    const success = newestOf("REFUND_SUCCESS");
    const failure = newestOf("REFUND_FAILURE");

    if (!success) {
      return 0;
    }

    if (failure && toMicroseconds(success.createdAt) <= toMicroseconds(failure.createdAt)) {
      return 0;
    }

    return success.amount.amount;
  }
}

describe("StripeWebhookUseCase - refund event before Saleor tagged its request (A2e round 2, P1)", () => {
  const mockApl = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn(),
  } satisfies APL;

  const eventVerify = {
    verifyEvent: vi.fn(),
  } satisfies IStripeEventVerify;

  const webhookParams = WebhookParams.createFromWebhookUrl(mockAdyenWebhookUrl)._unsafeUnwrap();

  const mockTransactionRecorder = new MockedTransactionRecorder();

  let saleor: FakeSaleorTransaction;
  let instance: StripeWebhookUseCase;

  beforeEach(() => {
    saleor = new FakeSaleorTransaction();
    mockApl.get.mockImplementation(async () => mockAuthData);
    mockTransactionRecorder.reset();
    mockTransactionRecorder.transactions = {
      [mockedStripePaymentIntentId]: getMockedRecordedTransaction(),
    };

    const reporter = {
      reportTransactionEvent: vi.fn(async (input: TransactionEventReportInput) => {
        saleor.report(input);

        return ok({ createdEventId: "event-id" });
      }),
    } satisfies ITransactionEventReporter;

    const fetcher = {
      fetchTransactionEvents: vi.fn(async () => ok(saleor.events)),
    } satisfies ITransactionEventsFetcher;

    instance = new StripeWebhookUseCase({
      apl: mockApl,
      appConfigRepo: mockedAppConfigRepo,
      webhookEventVerifyFactory: () => eventVerify,
      transactionEventReporterFactory: () => reporter,
      transactionEventsFetcherFactory: () => fetcher,
      transactionRecorder: mockTransactionRecorder,
      webhookManager: new StripeWebhookManager(),
    });
  });

  const deliverRefundCreated = () => {
    // The refund the app created a few seconds ago (its answer to Saleor was a 503).
    const event = getMockedRefundCreatedEvent({ createdBySaleor: true });

    event.data.object.created = Math.floor(Date.now() / 1000) - 8;
    eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));

    return instance.execute({
      rawBody: "TEST BODY",
      signatureHeader: "SIGNATURE",
      webhookParams,
    });
  };

  it("answers Stripe 500 before the request is tagged, and reports a linked success after", async () => {
    const early = await deliverRefundCreated();

    expect(early._unsafeUnwrapErr().statusCode).toBe(500);
    expect(saleor.events.filter((event) => event.type === "REFUND_SUCCESS")).toHaveLength(0);

    // Saleor re-sends TRANSACTION_REFUND_REQUESTED; the app answers with the refund id.
    saleor.tagRequestWith(mockedStripeRefundId);

    // Stripe re-sends refund.created.
    const resent = await deliverRefundCreated();

    expect(resent._unsafeUnwrap().statusCode).toBe(200);

    const successes = saleor.events.filter((event) => event.type === "REFUND_SUCCESS");

    expect(successes).toStrictEqual([
      expect.objectContaining({
        pspReference: mockedStripeRefundId,
        grantedRefundId: "granted-refund-1",
      }),
    ]);
  });

  /*
   * A2e round 3: Saleor decides a granted refund's status by its newest related event by
   * created_at (order/utils.py calculate_order_granted_refund_status), the report's `time`.
   * Stripe's event times are whole seconds; Saleor's REFUND_REQUEST has microseconds.
   */
  describe("granted refund status with second-precision Stripe times (round 3)", () => {
    const REQUEST_CREATED_AT = "2026-10-22T14:42:13.969132+00:00";
    const REQUEST_SECOND = Date.UTC(2026, 9, 22, 14, 42, 13) / 1000;

    const deliver = (
      type: "refund.created" | "refund.failed",
      eventCreated: number,
      status: Stripe.Refund["status"],
    ) => {
      const base = getMockedRefundCreatedEvent({ createdBySaleor: true, status });
      const event = {
        ...base,
        type,
        created: eventCreated,
        data: { object: { ...base.data.object, created: REQUEST_SECOND } },
      } as Stripe.RefundCreatedEvent;

      eventVerify.verifyEvent.mockImplementationOnce(() => ok(event));

      return instance.execute({ rawBody: "TEST BODY", signatureHeader: "SIGNATURE", webhookParams });
    };

    beforeEach(() => {
      saleor = new FakeSaleorTransaction(REQUEST_CREATED_AT);
      saleor.tagRequestWith(mockedStripeRefundId);
    });

    it("ends SUCCESS when Stripe's event is in the same second as Saleor's request", async () => {
      expect((await deliver("refund.created", REQUEST_SECOND, "succeeded")).isOk()).toBe(true);

      expect(saleor.grantedRefundStatus("granted-refund-1")).toBe("SUCCESS");
      expect(saleor.refundedAmountOf(mockedStripeRefundId)).toBe(10);
    });

    it("keeps Stripe's time when its event is in a later second, and ends SUCCESS", async () => {
      await deliver("refund.created", REQUEST_SECOND + 3, "succeeded");

      expect(saleor.events.find((event) => event.type === "REFUND_SUCCESS")?.createdAt).toBe(
        "2026-10-22T14:42:16.000Z",
      );
      expect(saleor.grantedRefundStatus("granted-refund-1")).toBe("SUCCESS");
    });

    it("ends FAILURE with nothing refunded when the refund succeeded and then failed", async () => {
      await deliver("refund.created", REQUEST_SECOND, "succeeded");

      expect(saleor.grantedRefundStatus("granted-refund-1")).toBe("SUCCESS");

      await deliver("refund.failed", REQUEST_SECOND + 2 * 86400, "failed");

      expect(saleor.grantedRefundStatus("granted-refund-1")).toBe("FAILURE");
      expect(saleor.refundedAmountOf(mockedStripeRefundId)).toBe(0);
    });
  });
});
