import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { parse } from "graphql";

/**
 * Inline (non-codegen) documents for /api/add-configured-cable: they need
 * fields the shared fragments do not carry (product slug, reference
 * attributes, checkout channel). Kept out of graphql/*.graphql on purpose so
 * they need no codegen run; validated against graphql/schema.graphql by
 * src/__tests__/inline-documents.test.ts.
 */

type Money = { gross: { amount: number; currency: string } };

export type CableBaseVariantQuery = {
  productVariant?: {
    id: string;
    product: { slug: string };
    pricing?: { price?: Money | null } | null;
    attributes: Array<{
      attribute: { slug?: string | null };
      values: Array<{ reference?: string | null }>;
    }>;
  } | null;
};

export type CableBaseVariantQueryVariables = { id: string; channel: string };

export const CableBaseVariantDocument: TypedDocumentNode<CableBaseVariantQuery, CableBaseVariantQueryVariables> =
  parse(`
    query CableBaseVariant($id: ID!, $channel: String!) {
      productVariant(id: $id, channel: $channel) {
        id
        product {
          slug
        }
        pricing {
          price {
            gross {
              amount
              currency
            }
          }
        }
        attributes {
          attribute {
            slug
          }
          values {
            reference
          }
        }
      }
    }
  `);

export type CableOptionProductsQuery = {
  products?: {
    edges: Array<{ node: { id: string; defaultVariant?: { id: string } | null } }>;
  } | null;
};

export type CableOptionProductsQueryVariables = { ids: string[]; channel: string };

/** At most 100 ids per call (Saleor's page-size cap). */
export const CABLE_OPTION_PRODUCTS_PAGE_SIZE = 100;

export const CableOptionProductsDocument: TypedDocumentNode<
  CableOptionProductsQuery,
  CableOptionProductsQueryVariables
> = parse(`
  query CableOptionProducts($ids: [ID!]!, $channel: String!) {
    products(first: 100, channel: $channel, filter: { ids: $ids }) {
      edges {
        node {
          id
          defaultVariant {
            id
          }
        }
      }
    }
  }
`);

export type CableCheckoutChannelQuery = {
  checkout?: { id: string; channel: { slug: string } } | null;
};

export type CableCheckoutChannelQueryVariables = { id: string };

export const CableCheckoutChannelDocument: TypedDocumentNode<
  CableCheckoutChannelQuery,
  CableCheckoutChannelQueryVariables
> = parse(`
  query CableCheckoutChannel($id: ID!) {
    checkout(id: $id) {
      id
      channel {
        slug
      }
    }
  }
`);
