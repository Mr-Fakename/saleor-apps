import { createGraphQLClient } from "@saleor/apps-shared/create-graphql-client";
import { describe, expect, it, vi } from "vitest";

import { mockedAppToken } from "@/__tests__/mocks/constants";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";

import { CheckoutPaymentStateFetcher } from "./checkout-payment-state-fetcher";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const checkout = {
  id: "Q2hlY2tvdXQ6MQ==",
  channel: { id: "Q2hhbm5lbDox" },
  totalPrice: { gross: { amount: 103, currency: "EUR" } },
  transactions: [],
};

const createFetcher = () =>
  new CheckoutPaymentStateFetcher(
    createGraphQLClient({ saleorApiUrl: mockedSaleorApiUrl, token: mockedAppToken }),
  );

describe("CheckoutPaymentStateFetcher", () => {
  it("queries Saleor with the app token and the checkout id, and returns the checkout", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: { checkout } }));

    const result = await createFetcher().fetchCheckoutPaymentState({ checkoutId: checkout.id });

    expect(result._unsafeUnwrap()).toStrictEqual(checkout);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0];

    expect(String(url)).toBe(mockedSaleorApiUrl);
    expect(new Headers(init?.headers).get("authorization-bearer")).toBe(mockedAppToken);

    expect(JSON.parse(String(init?.body))).toMatchObject({
      operationName: "FetchCheckoutPaymentState",
      variables: { checkoutId: checkout.id },
    });
  });

  it("returns null when Saleor has no such checkout", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: { checkout: null } }));

    const result = await createFetcher().fetchCheckoutPaymentState({ checkoutId: checkout.id });

    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("returns FetchError when Saleor answers with a GraphQL error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: { checkout: null },
        errors: [{ message: "You need one of the following permissions: HANDLE_PAYMENTS" }],
      }),
    );

    const result = await createFetcher().fetchCheckoutPaymentState({ checkoutId: checkout.id });

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(Error);
    expect(result._unsafeUnwrapErr().name).toBe("CheckoutPaymentStateFetcher.FetchError");
  });

  it("returns FetchError when the network request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));

    const result = await createFetcher().fetchCheckoutPaymentState({ checkoutId: checkout.id });

    expect(result._unsafeUnwrapErr().name).toBe("CheckoutPaymentStateFetcher.FetchError");
  });
});
