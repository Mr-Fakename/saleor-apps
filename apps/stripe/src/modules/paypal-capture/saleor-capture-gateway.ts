import { err, ok, Result } from "neverthrow";
import { Client } from "urql";

import {
  FetchCaptureTransactionDocument,
  RequestTransactionActionDocument,
  TransactionUpdateCaptureStateDocument,
} from "@/generated/graphql";
import { BaseError } from "@/lib/errors";

import { buildCaptureHoldMetadata } from "./capture-state-tags";
import { CaptureHoldReason, CaptureTransaction } from "./decide-capture";

export const SaleorCaptureGatewayError = BaseError.subclass("SaleorCaptureGatewayError", {
  props: {
    _internalName: "SaleorCaptureGatewayError" as const,
  },
});

type GatewayResult<T> = Promise<Result<T, InstanceType<typeof SaleorCaptureGatewayError>>>;

/** What the capture worker reads and writes in Saleor (app token, HANDLE_PAYMENTS). */
export interface ISaleorCaptureGateway {
  /** Null when Saleor has no such transaction (or not for this installation's token). */
  fetchTransaction(args: { transactionId: string }): GatewayResult<CaptureTransaction | null>;
  /** transactionRequestAction(CHARGE, amount): Saleor then calls this app's charge handler. */
  requestCharge(args: { transactionId: string; amount: number }): GatewayResult<void>;
  /** transactionRequestAction(CANCEL): Saleor takes the authorized amount, calls the cancel handler. */
  requestCancel(args: { transactionId: string }): GatewayResult<void>;
  /** The hold tags (capture-state-tags.ts). */
  tagHold(args: { transactionId: string; reason: CaptureHoldReason; checkedAt: Date }): GatewayResult<void>;
}

type MutationErrors = ReadonlyArray<{ readonly message?: string | null; readonly code: string }>;

const describeErrors = (errors: MutationErrors) =>
  errors.map((e) => `${e.code}: ${e.message ?? ""}`).join(", ");

/**
 * Saleor 3.22.74, verified in its source (graphql/payment/mutations/transaction/
 * transaction_request_action.py): the CHARGE amount is min(amount, authorized_value); no
 * amount = the authorized value. The mutation records the request and queues the
 * TRANSACTION_*_REQUESTED webhook to the transaction's owning app; it does not wait for it
 * (webhook/transport/synchronous/transport.py trigger_transaction_request ->
 * handle_transaction_request_task.delay). Spike S1: another app's HANDLE_PAYMENTS token works
 * the same way, so the app's own token does.
 */
export class SaleorCaptureGateway implements ISaleorCaptureGateway {
  private client: Pick<Client, "query" | "mutation">;

  constructor(client: Pick<Client, "query" | "mutation">) {
    this.client = client;
  }

  async fetchTransaction(args: { transactionId: string }): GatewayResult<CaptureTransaction | null> {
    try {
      const response = await this.client
        .query(
          FetchCaptureTransactionDocument,
          { transactionId: args.transactionId },
          // The capture decision reads amounts and the order: never from the urql cache.
          { requestPolicy: "network-only" },
        )
        .toPromise();

      if (response.error) {
        return err(new SaleorCaptureGatewayError("Failed to fetch the transaction", { cause: response.error }));
      }

      if (!response.data) {
        return err(new SaleorCaptureGatewayError("Failed to fetch the transaction - data missing"));
      }

      return ok(response.data.transaction ?? null);
    } catch (error) {
      return err(new SaleorCaptureGatewayError("Failed to fetch the transaction", { cause: error }));
    }
  }

  private async requestAction(variables: {
    transactionId: string;
    actionType: "CHARGE" | "CANCEL";
    amount?: number;
  }): GatewayResult<void> {
    try {
      const response = await this.client.mutation(RequestTransactionActionDocument, variables);

      if (response.error) {
        return err(
          new SaleorCaptureGatewayError(`transactionRequestAction(${variables.actionType}) failed`, {
            cause: response.error,
          }),
        );
      }

      const payload = response.data?.transactionRequestAction;

      if (!payload) {
        return err(
          new SaleorCaptureGatewayError(
            `transactionRequestAction(${variables.actionType}) failed - data missing`,
          ),
        );
      }

      if (payload.errors.length > 0) {
        return err(
          new SaleorCaptureGatewayError(
            `transactionRequestAction(${variables.actionType}) refused: ${describeErrors(payload.errors)}`,
          ),
        );
      }

      return ok(undefined);
    } catch (error) {
      return err(
        new SaleorCaptureGatewayError(`transactionRequestAction(${variables.actionType}) failed`, {
          cause: error,
        }),
      );
    }
  }

  async requestCharge(args: { transactionId: string; amount: number }) {
    return this.requestAction({ transactionId: args.transactionId, actionType: "CHARGE", amount: args.amount });
  }

  async requestCancel(args: { transactionId: string }) {
    return this.requestAction({ transactionId: args.transactionId, actionType: "CANCEL" });
  }

  async tagHold(args: { transactionId: string; reason: CaptureHoldReason; checkedAt: Date }): GatewayResult<void> {
    try {
      const response = await this.client.mutation(TransactionUpdateCaptureStateDocument, {
        transactionId: args.transactionId,
        metadata: buildCaptureHoldMetadata({ reason: args.reason, checkedAt: args.checkedAt }),
      });

      const errors = response.data?.transactionUpdate?.errors ?? [];

      if (response.error || !response.data?.transactionUpdate || errors.length > 0) {
        return err(
          new SaleorCaptureGatewayError(`Failed to tag the held transaction: ${describeErrors(errors)}`, {
            cause: response.error,
          }),
        );
      }

      return ok(undefined);
    } catch (error) {
      return err(new SaleorCaptureGatewayError("Failed to tag the held transaction", { cause: error }));
    }
  }
}
