import { graphql, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { FetchTransactionEventsDocument, TransactionEventReportDocument } from "@/generated/graphql";

import { env } from "./env";

const saleorApi = graphql.link(env.INTEGRATION_SALEOR_API_URL);

const handlers = [
  // StripeRefundHandler reads the transaction's events before reporting a refund (A2e).
  saleorApi.query(FetchTransactionEventsDocument, ({ variables }) => {
    return HttpResponse.json({
      data: {
        transaction: {
          id: variables.transactionId,
          events: [],
        },
      },
    });
  }),
  saleorApi.mutation(TransactionEventReportDocument, () => {
    return HttpResponse.json({
      data: {
        transactionEventReport: {
          errors: [],
          transactionEvent: {
            id: "test-saleor-event-id",
          },
        },
      },
    });
  }),
];

export const mswServer = setupServer(...handlers);
