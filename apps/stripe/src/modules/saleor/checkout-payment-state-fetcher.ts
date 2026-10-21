import { err, ok, Result } from "neverthrow";
import { Client } from "urql";

import {
  FetchCheckoutPaymentStateDocument,
  FetchCheckoutPaymentStateQuery,
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
   */
  fetchCheckoutPaymentState(args: {
    checkoutId: string;
  }): Promise<Result<CheckoutPaymentState | null, InstanceType<typeof FetchError>>>;
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

  async fetchCheckoutPaymentState(args: {
    checkoutId: string;
  }): Promise<Result<CheckoutPaymentState | null, InstanceType<typeof FetchError>>> {
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
}
