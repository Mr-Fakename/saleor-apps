import { createGraphQLClient } from "@saleor/apps-shared/create-graphql-client";
import { describe, expect, it, vi } from "vitest";

import { mockedAppToken } from "@/__tests__/mocks/constants";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";

import { TransactionEventsFetcher } from "./transaction-events-fetcher";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const TRANSACTION_ID = "VHJhbnNhY3Rpb25JdGVtOjE=";

const events = [
  {
    type: "REFUND_SUCCESS",
    pspReference: "pi_1",
    externalUrl: "https://dashboard.stripe.com/refunds/re_1",
    createdAt: "2026-10-01T10:00:00.123456+00:00",
    amount: { amount: 40.5, currency: "EUR" },
  },
];

const createFetcher = () =>
  new TransactionEventsFetcher(
    createGraphQLClient({ saleorApiUrl: mockedSaleorApiUrl, token: mockedAppToken }),
  );

describe("TransactionEventsFetcher", () => {
  it("queries Saleor with the app token and the transaction id, and returns its events", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: { transaction: { id: TRANSACTION_ID, events } } }));

    const result = await createFetcher().fetchTransactionEvents({ transactionId: TRANSACTION_ID });

    expect(result._unsafeUnwrap()).toStrictEqual(events);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0];

    expect(String(url)).toBe(mockedSaleorApiUrl);
    expect(new Headers(init?.headers).get("authorization-bearer")).toBe(mockedAppToken);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      operationName: "FetchTransactionEvents",
      variables: { transactionId: TRANSACTION_ID },
    });
  });

  it("returns null when Saleor has no such transaction", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: { transaction: null } }));

    const result = await createFetcher().fetchTransactionEvents({ transactionId: TRANSACTION_ID });

    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("returns FetchError when Saleor answers with a GraphQL error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: { transaction: null },
        errors: [{ message: "You need one of the following permissions: HANDLE_PAYMENTS" }],
      }),
    );

    const result = await createFetcher().fetchTransactionEvents({ transactionId: TRANSACTION_ID });

    expect(result._unsafeUnwrapErr().name).toBe("TransactionEventsFetcher.FetchError");
  });

  it("returns FetchError when the network request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));

    const result = await createFetcher().fetchTransactionEvents({ transactionId: TRANSACTION_ID });

    expect(result._unsafeUnwrapErr().name).toBe("TransactionEventsFetcher.FetchError");
  });
});
