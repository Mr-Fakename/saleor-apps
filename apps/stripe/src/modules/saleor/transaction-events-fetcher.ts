import { err, ok, Result } from "neverthrow";
import { Client } from "urql";

import { FetchTransactionEventsDocument, FetchTransactionEventsQuery } from "@/generated/graphql";
import { BaseError } from "@/lib/errors";

/** One event Saleor recorded on a transaction, with its amount and creation time. */
export type FetchedTransactionEvent = NonNullable<
  FetchTransactionEventsQuery["transaction"]
>["events"][number];

const FetchError = BaseError.subclass("TransactionEventsFetcher.FetchError", {
  props: {
    _internalName: "TransactionEventsFetcher.FetchError" as const,
  },
});

export const TransactionEventsFetcherErrors = {
  FetchError,
};

export interface ITransactionEventsFetcher {
  /**
   * Resolves to `null` when Saleor has no such transaction.
   */
  fetchTransactionEvents(args: {
    transactionId: string;
  }): Promise<
    Result<ReadonlyArray<FetchedTransactionEvent> | null, InstanceType<typeof FetchError>>
  >;
}

/**
 * Must be given a client authenticated with the app token: `Query.transaction` requires
 * HANDLE_PAYMENTS or MANAGE_ORDERS (saleor/graphql/payment/schema.py, 3.22.74).
 */
export class TransactionEventsFetcher implements ITransactionEventsFetcher {
  private client: Pick<Client, "query">;

  constructor(client: Pick<Client, "query">) {
    this.client = client;
  }

  async fetchTransactionEvents(args: {
    transactionId: string;
  }): Promise<
    Result<ReadonlyArray<FetchedTransactionEvent> | null, InstanceType<typeof FetchError>>
  > {
    try {
      const response = await this.client
        .query(
          FetchTransactionEventsDocument,
          { transactionId: args.transactionId },
          // Decides which pspReference a refund is reported under: never from the urql cache.
          { requestPolicy: "network-only" },
        )
        .toPromise();

      if (response.error) {
        return err(new FetchError("Failed to fetch transaction events", { cause: response.error }));
      }

      if (!response.data) {
        return err(new FetchError("Failed to fetch transaction events - data missing"));
      }

      return ok(response.data.transaction?.events ?? null);
    } catch (error) {
      return err(new FetchError("Failed to fetch transaction events", { cause: error }));
    }
  }
}
