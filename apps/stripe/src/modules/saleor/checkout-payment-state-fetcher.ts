import { err, ok, Result } from "neverthrow";
import { Client } from "urql";

import {
  FetchCheckoutPaymentStateDocument,
  FetchCheckoutPaymentStateQuery,
  FetchCheckoutPaymentStateWithLinesDocument,
  FetchCheckoutPaymentStateWithLinesQuery,
} from "@/generated/graphql";
import { BaseError } from "@/lib/errors";

/**
 * The server-side view of a checkout that a payment amount is derived from:
 * its total and the money its transactions already hold.
 */
export type CheckoutPaymentState = NonNullable<FetchCheckoutPaymentStateQuery["checkout"]>;

export type CheckoutPaymentStateTransaction = NonNullable<
  CheckoutPaymentState["transactions"]
>[number];

/**
 * The same view plus the checkout lines, read in the same query so that the PayPal fee line is
 * checked against the snapshot the amount comes from (A3c). Only the PayPal-fee gate asks for it.
 */
export type CheckoutPaymentStateWithLines = NonNullable<
  FetchCheckoutPaymentStateWithLinesQuery["checkout"]
>;

export type CheckoutPaymentStateLine = CheckoutPaymentStateWithLines["lines"][number];

const FetchError = BaseError.subclass("CheckoutPaymentStateFetcher.FetchError", {
  props: {
    _internalName: "CheckoutPaymentStateFetcher.FetchError" as const,
  },
});

export const CheckoutPaymentStateFetcherErrors = {
  FetchError,
};

export interface ICheckoutPaymentStateFetcher {
  /**
   * Resolves to `null` when Saleor has no such checkout (unknown id, or the
   * checkout was already completed into an order and deleted).
   *
   * `includeLines: true` sends FetchCheckoutPaymentStateWithLines instead (PayPal-fee gate on);
   * without it, the query is FetchCheckoutPaymentState with `{ checkoutId }`, as before.
   */
  fetchCheckoutPaymentState(args: {
    checkoutId: string;
    includeLines?: false;
  }): Promise<Result<CheckoutPaymentState | null, InstanceType<typeof FetchError>>>;
  fetchCheckoutPaymentState(args: {
    checkoutId: string;
    includeLines: true;
  }): Promise<Result<CheckoutPaymentStateWithLines | null, InstanceType<typeof FetchError>>>;
}

/**
 * Must be given a client authenticated with the app token (HANDLE_PAYMENTS):
 * `Checkout.transactions` is not readable without it.
 */
export class CheckoutPaymentStateFetcher implements ICheckoutPaymentStateFetcher {
  private client: Pick<Client, "query">;

  constructor(client: Pick<Client, "query">) {
    this.client = client;
  }

  fetchCheckoutPaymentState(args: {
    checkoutId: string;
    includeLines?: false;
  }): Promise<Result<CheckoutPaymentState | null, InstanceType<typeof FetchError>>>;
  fetchCheckoutPaymentState(args: {
    checkoutId: string;
    includeLines: true;
  }): Promise<Result<CheckoutPaymentStateWithLines | null, InstanceType<typeof FetchError>>>;
  async fetchCheckoutPaymentState(args: {
    checkoutId: string;
    includeLines?: boolean;
  }): Promise<
    Result<CheckoutPaymentState | CheckoutPaymentStateWithLines | null, InstanceType<typeof FetchError>>
  > {
    if (args.includeLines) {
      return this.fetchCheckoutPaymentStateWithLines(args.checkoutId);
    }

    try {
      const response = await this.client
        .query(
          FetchCheckoutPaymentStateDocument,
          { checkoutId: args.checkoutId },
          // Totals drive a charge amount: never serve them from the urql cache.
          { requestPolicy: "network-only" },
        )
        .toPromise();

      if (response.error) {
        return err(new FetchError("Failed to fetch checkout payment state", { cause: response.error }));
      }

      if (!response.data) {
        return err(new FetchError("Failed to fetch checkout payment state - data missing"));
      }

      return ok(response.data.checkout ?? null);
    } catch (error) {
      return err(new FetchError("Failed to fetch checkout payment state", { cause: error }));
    }
  }

  private async fetchCheckoutPaymentStateWithLines(
    checkoutId: string,
  ): Promise<Result<CheckoutPaymentStateWithLines | null, InstanceType<typeof FetchError>>> {
    try {
      const response = await this.client
        .query(
          FetchCheckoutPaymentStateWithLinesDocument,
          { checkoutId },
          // Totals and the fee line drive a charge amount: never serve them from the urql cache.
          { requestPolicy: "network-only" },
        )
        .toPromise();

      if (response.error) {
        return err(
          new FetchError("Failed to fetch checkout payment state with lines", {
            cause: response.error,
          }),
        );
      }

      if (!response.data) {
        return err(
          new FetchError("Failed to fetch checkout payment state with lines - data missing"),
        );
      }

      return ok(response.data.checkout ?? null);
    } catch (error) {
      return err(
        new FetchError("Failed to fetch checkout payment state with lines", { cause: error }),
      );
    }
  }
}
