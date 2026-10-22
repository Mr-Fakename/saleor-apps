import { describe, expect, it } from "vitest";

import { mockedStripePaymentIntentId } from "@/__tests__/mocks/mocked-stripe-payment-intent-id";
import { TransactionEventTypeEnum } from "@/generated/graphql";
import { generateRefundStripeDashboardUrl } from "@/modules/stripe/generate-stripe-dashboard-urls";
import { createStripeRefundId } from "@/modules/stripe/stripe-refund-id";

import {
  createRefundFailurePspReference,
  RecordedRefundEvidenceEvent,
  resolveStripeRefundPspReference,
} from "./refund-psp-reference";

const REFUND_ID = createStripeRefundId("re_THIS_REFUND");
const OTHER_REFUND_ID = createStripeRefundId("re_OTHER_REFUND");
const PI = mockedStripePaymentIntentId;

/** 2026-10-22T10:00:00Z, when Stripe created REFUND_ID. */
const REFUND_CREATED = Date.UTC(2026, 9, 22, 10, 0, 0) / 1000;

const isoAt = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

const stripeRefund = { id: REFUND_ID, amount: 40_50, currency: "eur", created: REFUND_CREATED };

/** What StripeRefundHandler reported before A2e: the PaymentIntent, the refund in externalUrl. */
const reportedUnderPaymentIntent = (
  type: TransactionEventTypeEnum,
  refundId = REFUND_ID,
): RecordedRefundEvidenceEvent => ({
  type,
  pspReference: PI,
  externalUrl: generateRefundStripeDashboardUrl(refundId, "LIVE"),
  amount: { amount: 40.5, currency: "EUR" },
  createdAt: isoAt(REFUND_CREATED + 2),
});

/**
 * The REFUND_REQUEST Saleor creates for a refund request, after the app answered it with the
 * PaymentIntent before A2e: Saleor only copies the pspReference, so there is no externalUrl.
 */
const requestAnsweredWithPaymentIntent = (args: {
  amount?: number;
  createdAt: number;
}): RecordedRefundEvidenceEvent => ({
  type: "REFUND_REQUEST",
  pspReference: PI,
  externalUrl: "",
  amount: { amount: args.amount ?? 40.5, currency: "EUR" },
  createdAt: isoAt(args.createdAt),
});

const resolve = (recordedEvents: ReadonlyArray<RecordedRefundEvidenceEvent>) =>
  resolveStripeRefundPspReference({
    stripeRefund,
    stripePaymentIntentId: PI,
    recordedEvents,
  });

describe("resolveStripeRefundPspReference", () => {
  it("tracks a refund under its own Stripe refund id when Saleor recorded nothing", () => {
    expect(resolve([])).toBe(REFUND_ID);
  });

  it("keeps tracking it under its own id once Saleor holds events with that id", () => {
    expect(
      resolve([
        {
          type: "REFUND_REQUEST",
          pspReference: REFUND_ID,
          externalUrl: "",
          amount: { amount: 40.5, currency: "EUR" },
          createdAt: isoAt(REFUND_CREATED - 1),
        },
      ]),
    ).toBe(REFUND_ID);
  });

  it("gives two refunds of one PaymentIntent two distinct pspReferences", () => {
    const first = resolveStripeRefundPspReference({
      stripeRefund: { ...stripeRefund, id: createStripeRefundId("re_FIRST") },
      stripePaymentIntentId: PI,
      recordedEvents: [],
    });
    const second = resolveStripeRefundPspReference({
      stripeRefund: { ...stripeRefund, id: createStripeRefundId("re_SECOND") },
      stripePaymentIntentId: PI,
      recordedEvents: [
        {
          type: "REFUND_SUCCESS",
          pspReference: "re_FIRST",
          externalUrl: "",
          amount: { amount: 40.5, currency: "EUR" },
          createdAt: isoAt(REFUND_CREATED),
        },
      ],
    });

    expect(first).toBe("re_FIRST");
    expect(second).toBe("re_SECOND");
  });

  /*
   * Compatibility with refunds recorded before A2e: Saleor groups refund events by
   * pspReference. A REFUND_SUCCESS under its re_ id for a refund already counted under the
   * PaymentIntent would count it twice; its REFUND_FAILURE under the re_ id would cancel
   * nothing and leave the failed refund in refundedAmount.
   */
  describe("a refund Saleor recorded under the PaymentIntent before A2e", () => {
    it.each<TransactionEventTypeEnum>(["REFUND_SUCCESS", "REFUND_REQUEST", "REFUND_FAILURE"])(
      "stays under the PaymentIntent when a %s under it names this refund in externalUrl",
      (type) => {
        expect(resolve([reportedUnderPaymentIntent(type)])).toBe(PI);
      },
    );

    it("stays under the PaymentIntent even when an event under its own id exists too", () => {
      expect(
        resolve([
          reportedUnderPaymentIntent("REFUND_SUCCESS"),
          {
            type: "REFUND_REQUEST",
            pspReference: REFUND_ID,
            externalUrl: "",
            amount: { amount: 40.5, currency: "EUR" },
            createdAt: isoAt(REFUND_CREATED + 3600),
          },
        ]),
      ).toBe(PI);
    });

    it("stays under the PaymentIntent when only the request that created it is recorded (same amount, seconds before)", () => {
      expect(resolve([requestAnsweredWithPaymentIntent({ createdAt: REFUND_CREATED - 5 })])).toBe(
        PI,
      );
    });

    it("stays under the PaymentIntent when that request got the refund back from Stripe (idempotency replay, within 24 h)", () => {
      expect(
        resolve([requestAnsweredWithPaymentIntent({ createdAt: REFUND_CREATED + 3 * 3600 })]),
      ).toBe(PI);
    });

    it("uses the payload's events when they carry no amount or time (TRANSACTION_REFUND_REQUESTED subscription)", () => {
      expect(
        resolve([
          {
            type: "REFUND_SUCCESS",
            pspReference: PI,
            externalUrl: generateRefundStripeDashboardUrl(REFUND_ID, "TEST"),
          },
        ]),
      ).toBe(PI);
    });
  });

  describe("does not take another refund's PaymentIntent events for this one", () => {
    it("ignores an event under the PaymentIntent that names another refund", () => {
      expect(
        resolve([reportedUnderPaymentIntent("REFUND_SUCCESS", OTHER_REFUND_ID)]),
      ).toBe(REFUND_ID);
    });

    it("ignores a PaymentIntent request of another amount", () => {
      expect(
        resolve([
          requestAnsweredWithPaymentIntent({ amount: 100, createdAt: REFUND_CREATED - 5 }),
        ]),
      ).toBe(REFUND_ID);
    });

    it("ignores a PaymentIntent request made long before this refund (a new refund of the same amount)", () => {
      expect(
        resolve([requestAnsweredWithPaymentIntent({ createdAt: REFUND_CREATED - 2 * 86400 })]),
      ).toBe(REFUND_ID);
    });

    it("ignores a PaymentIntent request made more than 24 h after the refund", () => {
      expect(
        resolve([requestAnsweredWithPaymentIntent({ createdAt: REFUND_CREATED + 2 * 86400 })]),
      ).toBe(REFUND_ID);
    });

    it("ignores a PaymentIntent request when the event has no amount or time to compare", () => {
      expect(
        resolve([{ type: "REFUND_REQUEST", pspReference: PI, externalUrl: "" }]),
      ).toBe(REFUND_ID);
    });

    it("ignores charge events under the PaymentIntent", () => {
      expect(
        resolve([
          {
            type: "CHARGE_SUCCESS",
            pspReference: PI,
            externalUrl: "",
            amount: { amount: 40.5, currency: "EUR" },
            createdAt: isoAt(REFUND_CREATED - 5),
          },
        ]),
      ).toBe(REFUND_ID);
    });
  });
});

describe("createRefundFailurePspReference", () => {
  it("never repeats, and is never a PaymentIntent or a Stripe refund id", () => {
    const references = Array.from({ length: 50 }, () => createRefundFailurePspReference());

    expect(new Set(references).size).toBe(references.length);

    for (const reference of references) {
      expect(reference).toMatch(/^refund-failure-[0-9a-f-]{36}$/);
      expect(reference).not.toMatch(/^(pi|re|pyr)_/);
    }
  });
});
