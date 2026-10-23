import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { mockedStripeRestrictedKey } from "@/__tests__/mocks/mocked-stripe-restricted-key";
import { StripeClient } from "@/modules/stripe/stripe-client";

import {
  PAYPAL_AWAITING_APP_CAPTURE_SEARCH_QUERY,
  StripePaymentIntentsApi,
} from "./stripe-payment-intents-api";

type SearchPage = Awaited<ReturnType<Stripe["paymentIntents"]["search"]>>;

/** A search result page with only the fields the method reads. */
const page = (ids: string[], nextPage: string | null) =>
  ({ data: ids.map((id) => ({ id })), has_more: nextPage !== null, next_page: nextPage }) as unknown as SearchPage;

/*
 * A3d sweep: the paypal-only authorizations waiting for the app's capture, from Stripe's search
 * (which lags up to about a minute; each one is read again live before any decision).
 */
describe("StripePaymentIntentsApi.searchPaymentIntentsAwaitingAppCapture", () => {
  it("uses the A3d query", () => {
    expect(PAYPAL_AWAITING_APP_CAPTURE_SEARCH_QUERY).toBe(
      'status:"requires_capture" AND metadata["saleor_payment_policy"]:"paypal-only"',
    );
  });

  it("follows the pages", async () => {
    const client = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
    const search = vi
      .spyOn(client.nativeClient.paymentIntents, "search")
      .mockResolvedValueOnce(page(["pi_1", "pi_2"], "page_2"))
      .mockResolvedValueOnce(page(["pi_3"], null));

    const result = await StripePaymentIntentsApi.createFromClient(client).searchPaymentIntentsAwaitingAppCapture();

    expect(result._unsafeUnwrap().map((pi) => pi.id)).toStrictEqual(["pi_1", "pi_2", "pi_3"]);
    expect(search.mock.calls.map(([params]) => params)).toStrictEqual([
      { query: PAYPAL_AWAITING_APP_CAPTURE_SEARCH_QUERY, limit: 100 },
      { query: PAYPAL_AWAITING_APP_CAPTURE_SEARCH_QUERY, limit: 100, page: "page_2" },
    ]);
  });

  it("stops after 10 pages (1000 authorizations) and returns what it read", async () => {
    const client = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);
    const search = vi
      .spyOn(client.nativeClient.paymentIntents, "search")
      .mockResolvedValue(page(["pi_x"], "next"));

    const result = await StripePaymentIntentsApi.createFromClient(client).searchPaymentIntentsAwaitingAppCapture();

    expect(search).toHaveBeenCalledTimes(10);
    expect(result._unsafeUnwrap()).toHaveLength(10);
  });

  it("returns the Stripe error", async () => {
    const client = StripeClient.createFromRestrictedKey(mockedStripeRestrictedKey);

    vi.spyOn(client.nativeClient.paymentIntents, "search").mockRejectedValue(new Error("rate limited"));

    const result = await StripePaymentIntentsApi.createFromClient(client).searchPaymentIntentsAwaitingAppCapture();

    expect(result.isErr()).toBe(true);
  });
});
