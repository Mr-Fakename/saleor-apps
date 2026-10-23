import { beforeEach, describe, expect, it, vi } from "vitest";

import { a3dTransaction } from "@/__tests__/mocks/paypal-capture-fixtures";
import {
  FetchCaptureTransactionDocument,
  RequestTransactionActionDocument,
  TransactionUpdateCaptureStateDocument,
} from "@/generated/graphql";

import { SaleorCaptureGateway, SaleorCaptureGatewayError } from "./saleor-capture-gateway";

/*
 * A3d talks to Saleor with the app token (HANDLE_PAYMENTS only, no manifest change):
 * - FetchCaptureTransaction: transaction(id) with its order (status, total, lines with
 *   productVariantId, transactions, legacy payments);
 * - RequestTransactionAction: transactionRequestAction(CHARGE, amount) / (CANCEL). Saleor then
 *   sends TRANSACTION_CHARGE_REQUESTED / _CANCELATION_REQUESTED to this app's handlers;
 * - TransactionUpdateCaptureState: the hold tags, a document of its own (gate on only), so
 *   SDS and gate-off send exactly today's documents.
 */

const query = vi.fn();
const mutation = vi.fn();
const client = { query, mutation };

const TX_ID = "VHJhbnNhY3Rpb25JdGVtOjQy";

describe("SaleorCaptureGateway", () => {
  beforeEach(() => {
    query.mockReset();
    mutation.mockReset();
  });

  describe("fetchTransaction", () => {
    it("reads the transaction with its order, never from the urql cache", async () => {
      const transaction = a3dTransaction("pi_3Gateway");

      query.mockReturnValue({ toPromise: async () => ({ data: { transaction } }) });

      const result = await new SaleorCaptureGateway(client).fetchTransaction({ transactionId: TX_ID });

      expect(result._unsafeUnwrap()).toStrictEqual(transaction);
      expect(query.mock.calls).toStrictEqual([
        [FetchCaptureTransactionDocument, { transactionId: TX_ID }, { requestPolicy: "network-only" }],
      ]);
    });

    it("resolves null when Saleor has no such transaction", async () => {
      query.mockReturnValue({ toPromise: async () => ({ data: { transaction: null } }) });

      const result = await new SaleorCaptureGateway(client).fetchTransaction({ transactionId: TX_ID });

      expect(result._unsafeUnwrap()).toBeNull();
    });

    it.each([
      { case: "a GraphQL error", response: { error: new Error("permission denied") } },
      { case: "no data", response: {} },
    ])("fails on $case", async ({ response }) => {
      query.mockReturnValue({ toPromise: async () => response });

      const result = await new SaleorCaptureGateway(client).fetchTransaction({ transactionId: TX_ID });

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SaleorCaptureGatewayError);
    });
  });

  describe("requestCharge / requestCancel", () => {
    it("asks Saleor to CHARGE the order total", async () => {
      mutation.mockResolvedValue({ data: { transactionRequestAction: { errors: [], transaction: { id: TX_ID } } } });

      const result = await new SaleorCaptureGateway(client).requestCharge({ transactionId: TX_ID, amount: 101.5 });

      expect(result.isOk()).toBe(true);
      expect(mutation.mock.calls).toStrictEqual([
        [RequestTransactionActionDocument, { transactionId: TX_ID, actionType: "CHARGE", amount: 101.5 }],
      ]);
    });

    it("asks Saleor to CANCEL the authorization (Saleor takes the authorized amount)", async () => {
      mutation.mockResolvedValue({ data: { transactionRequestAction: { errors: [], transaction: { id: TX_ID } } } });

      await new SaleorCaptureGateway(client).requestCancel({ transactionId: TX_ID });

      expect(mutation.mock.calls).toStrictEqual([
        [RequestTransactionActionDocument, { transactionId: TX_ID, actionType: "CANCEL" }],
      ]);
    });

    it.each([
      {
        case: "a mutation error",
        response: {
          data: {
            transactionRequestAction: {
              errors: [{ field: null, code: "MISSING_TRANSACTION_ACTION_REQUEST_WEBHOOK", message: "No app" }],
              transaction: null,
            },
          },
        },
      },
      { case: "a GraphQL error", response: { error: new Error("network") } },
      { case: "no data", response: {} },
    ])("fails on $case", async ({ response }) => {
      mutation.mockResolvedValue(response);

      const result = await new SaleorCaptureGateway(client).requestCharge({ transactionId: TX_ID, amount: 101.5 });

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SaleorCaptureGatewayError);
    });

    it("fails, without throwing, when the client throws", async () => {
      mutation.mockRejectedValue(new Error("socket hang up"));

      const result = await new SaleorCaptureGateway(client).requestCancel({ transactionId: TX_ID });

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SaleorCaptureGatewayError);
    });
  });

  describe("tagHold", () => {
    it("writes the three capture tags to the transaction's public metadata", async () => {
      mutation.mockResolvedValue({ data: { transactionUpdate: { errors: [], transaction: { id: TX_ID } } } });

      const result = await new SaleorCaptureGateway(client).tagHold({
        transactionId: TX_ID,
        reason: "fee-absent",
        checkedAt: new Date("2026-10-23T10:00:00.000Z"),
      });

      expect(result.isOk()).toBe(true);
      expect(mutation.mock.calls).toStrictEqual([
        [
          TransactionUpdateCaptureStateDocument,
          {
            transactionId: TX_ID,
            metadata: [
              { key: "stripe_capture_state", value: "held" },
              { key: "stripe_capture_hold_reason", value: "fee-absent" },
              { key: "stripe_capture_checked_at", value: "2026-10-23T10:00:00.000Z" },
            ],
          },
        ],
      ]);
    });

    it("fails on a mutation error", async () => {
      mutation.mockResolvedValue({
        data: { transactionUpdate: { errors: [{ field: "metadata", code: "INVALID", message: "x" }], transaction: null } },
      });

      const result = await new SaleorCaptureGateway(client).tagHold({
        transactionId: TX_ID,
        reason: "fee-absent",
        checkedAt: new Date(),
      });

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SaleorCaptureGatewayError);
    });
  });
});
