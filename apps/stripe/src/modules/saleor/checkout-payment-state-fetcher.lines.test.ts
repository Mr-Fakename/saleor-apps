import { createGraphQLClient } from "@saleor/apps-shared/create-graphql-client";
import { describe, expect, it, vi } from "vitest";

import { mockedAppToken } from "@/__tests__/mocks/constants";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";

import { CheckoutPaymentStateFetcher } from "./checkout-payment-state-fetcher";

/*
 * A3c §4 query choice: today's FetchCheckoutPaymentState document (no lines) unless the caller
 * asks for the lines, which only the PayPal-fee gate does.
 */

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const checkout = {
  id: "Q2hlY2tvdXQ6MQ==",
  channel: { id: "Q2hhbm5lbDox" },
  totalPrice: { gross: { amount: 213.15, currency: "EUR" } },
  transactions: [],
};

const lines = [
  {
    id: "Q2hlY2tvdXRMaW5lOjI=",
    quantity: 1,
    variant: { id: "UHJvZHVjdFZhcmlhbnQ6NDQ5" },
    metadata: [{ key: "payment_fee_type", value: "paypal_1.5_percent" }],
    totalPrice: { gross: { amount: 3.15, currency: "EUR" } },
  },
];

const createFetcher = () =>
  new CheckoutPaymentStateFetcher(
    createGraphQLClient({ saleorApiUrl: mockedSaleorApiUrl, token: mockedAppToken }),
  );

const sentBody = (fetchSpy: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) =>
  JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit | undefined)?.body)) as {
    operationName: string;
    query: string;
    variables: unknown;
  };

describe("CheckoutPaymentStateFetcher: query choice", () => {
  it("sends today's query, without lines, when the caller does not ask for them", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: { checkout } }));

    await createFetcher().fetchCheckoutPaymentState({ checkoutId: checkout.id });

    const body = sentBody(fetchSpy);

    expect(body.operationName).toBe("FetchCheckoutPaymentState");
    expect(body.variables).toStrictEqual({ checkoutId: checkout.id });
    expect(body.query).not.toMatch(/\blines\b/);
  });

  it("sends the lines query with the same variables when the caller asks for the lines", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: { checkout: { ...checkout, lines } } }));

    const result = await createFetcher().fetchCheckoutPaymentState({
      checkoutId: checkout.id,
      includeLines: true,
    });

    const body = sentBody(fetchSpy);

    expect(body.operationName).toBe("FetchCheckoutPaymentStateWithLines");
    expect(body.variables).toStrictEqual({ checkoutId: checkout.id });
    expect(body.query).toMatch(/\blines\s*\{/);
    expect(result._unsafeUnwrap()).toStrictEqual({ ...checkout, lines });
  });

  it("returns null when Saleor has no such checkout (lines query)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: { checkout: null } }));

    const result = await createFetcher().fetchCheckoutPaymentState({
      checkoutId: checkout.id,
      includeLines: true,
    });

    expect(result._unsafeUnwrap()).toBeNull();
  });
});
