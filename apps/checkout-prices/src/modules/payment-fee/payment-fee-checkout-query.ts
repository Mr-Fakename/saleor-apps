import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { parse } from "graphql";

/**
 * Inline (non-codegen) query: CheckoutDetailsFragment has no checkout-level
 * total, and the fee must be computed from one consistent snapshot of the
 * total and the existing fee lines. Kept out of graphql/*.graphql on purpose
 * so it needs no codegen run; validated against graphql/schema.graphql by
 * src/__tests__/inline-documents.test.ts.
 */

type Money = { gross: { amount: number; currency: string } };

export type PaymentFeeCheckoutQuery = {
  checkout?: {
    id: string;
    totalPrice: Money;
    lines: Array<{
      id: string;
      quantity: number;
      metadata: Array<{ key: string; value: string }>;
      totalPrice: Money;
    }>;
  } | null;
};

export type PaymentFeeCheckoutQueryVariables = { id: string };

export const PaymentFeeCheckoutDocument: TypedDocumentNode<PaymentFeeCheckoutQuery, PaymentFeeCheckoutQueryVariables> =
  parse(`
    query PaymentFeeCheckout($id: ID!) {
      checkout(id: $id) {
        id
        totalPrice {
          gross {
            amount
            currency
          }
        }
        lines {
          id
          quantity
          metadata {
            key
            value
          }
          totalPrice {
            gross {
              amount
              currency
            }
          }
        }
      }
    }
  `);
