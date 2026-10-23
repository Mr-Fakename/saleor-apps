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
import { createTimeoutFetch, isRequestTimeout, SALEOR_REQUEST_TIMEOUT_MS } from "./saleor-request-timeout";

export const SaleorCaptureGatewayError = BaseError.subclass("SaleorCaptureGatewayError", {
  props: {
    _internalName: "SaleorCaptureGatewayError" as const,
  },
});

/**
 * The call did not answer within SALEOR_REQUEST_TIMEOUT_MS. For a request it means the outcome
 * is UNKNOWN: Saleor may have recorded it and sent the webhook. The coordinator counts it and
 * decides only after re-reading the PaymentIntent (never a blind re-request).
 */
export const SaleorCaptureGatewayTimeoutError = SaleorCaptureGatewayError.subclass(
  "SaleorCaptureGatewayTimeoutError",
  {
    props: {
      _internalName: "SaleorCaptureGatewayTimeoutError" as const,
    },
  },
);

/** The urql error of a failed call: a timeout, or any other failure. */
const failure = (
  message: string,
  cause?: { networkError?: unknown } | unknown,
): SaleorCaptureGatewayFailure => {
  const networkError =
    typeof cause === "object" && cause !== null && "networkError" in cause
      ? (cause as { networkError?: unknown }).networkError
      : cause;

  return isRequestTimeout(networkError)
    ? new SaleorCaptureGatewayTimeoutError(`${message}: timed out after ${SALEOR_REQUEST_TIMEOUT_MS} ms`, { cause })
    : new SaleorCaptureGatewayError(message, { cause });
};

/** A failed call: a timeout (outcome unknown) or any other failure. */
export type SaleorCaptureGatewayFailure = InstanceType<
  typeof SaleorCaptureGatewayError | typeof SaleorCaptureGatewayTimeoutError
>;

type GatewayResult<T> = Promise<Result<T, SaleorCaptureGatewayFailure>>;

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
  /** Every call ends within SALEOR_REQUEST_TIMEOUT_MS (review of d462375c, item 5). */
  private timeoutFetch: typeof fetch;

  constructor(
    client: Pick<Client, "query" | "mutation">,
    /** For tests: another timeout, another underlying fetch. */
    opts?: { timeoutMs?: number; fetch?: typeof fetch },
  ) {
    this.client = client;
    this.timeoutFetch = createTimeoutFetch(opts?.timeoutMs ?? SALEOR_REQUEST_TIMEOUT_MS, opts?.fetch);
  }

  async fetchTransaction(args: { transactionId: string }): GatewayResult<CaptureTransaction | null> {
    try {
      const response = await this.client
        .query(
          FetchCaptureTransactionDocument,
          { transactionId: args.transactionId },
          // The capture decision reads amounts and the order: never from the urql cache.
          { requestPolicy: "network-only", fetch: this.timeoutFetch },
        )
        .toPromise();

      if (response.error) {
        return err(failure("Failed to fetch the transaction", response.error));
      }

      if (!response.data) {
        return err(new SaleorCaptureGatewayError("Failed to fetch the transaction - data missing"));
      }

      return ok(response.data.transaction ?? null);
    } catch (error) {
      return err(failure("Failed to fetch the transaction", error));
    }
  }

  private async requestAction(variables: {
    transactionId: string;
    actionType: "CHARGE" | "CANCEL";
    amount?: number;
  }): GatewayResult<void> {
    try {
      const response = await this.client.mutation(RequestTransactionActionDocument, variables, {
        fetch: this.timeoutFetch,
      });

      if (response.error) {
        return err(failure(`transactionRequestAction(${variables.actionType}) failed`, response.error));
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
      return err(failure(`transactionRequestAction(${variables.actionType}) failed`, error));
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
      const response = await this.client.mutation(
        TransactionUpdateCaptureStateDocument,
        {
          transactionId: args.transactionId,
          metadata: buildCaptureHoldMetadata({ reason: args.reason, checkedAt: args.checkedAt }),
        },
        { fetch: this.timeoutFetch },
      );

      const errors = response.data?.transactionUpdate?.errors ?? [];

      if (response.error || !response.data?.transactionUpdate || errors.length > 0) {
        return err(failure(`Failed to tag the held transaction: ${describeErrors(errors)}`, response.error));
      }

      return ok(undefined);
    } catch (error) {
      return err(failure("Failed to tag the held transaction", error));
    }
  }
}
