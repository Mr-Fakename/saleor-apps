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

export type CableLineMarkerMutation = {
  updatePrivateMetadata?: {
    errors: Array<{ field?: string | null; message?: string | null; code: string }>;
  } | null;
};

export type CableLineMarkerMutationVariables = {
  /** CheckoutLine global ID */
  id: string;
  input: Array<{ key: string; value: string }>;
};

/** Writes the PRIVATE verification record on a checkout line (modules/cable/cable-line-marker.ts). */
export const CableLineMarkerDocument: TypedDocumentNode<CableLineMarkerMutation, CableLineMarkerMutationVariables> =
  parse(`
    mutation CableLineMarker($id: ID!, $input: [MetadataInput!]!) {
      updatePrivateMetadata(id: $id, input: $input) {
        errors {
          field
          message
          code
        }
      }
    }
  `);

type DirectionAttributeResult = {
  slug?: string | null;
  choices?: { edges: Array<{ node: { id: string; name?: string | null } }> } | null;
} | null;

export type CableDirectionChoicesQuery = { attribute?: DirectionAttributeResult };

export type CableDirectionChoicesQueryVariables = { slug: string };

/** The values of ONE direction attribute (the slug assigned to the base variant; modules/cable/cable-direction.ts). */
export const CableDirectionChoicesDocument: TypedDocumentNode<
  CableDirectionChoicesQuery,
  CableDirectionChoicesQueryVariables
> = parse(`
  query CableDirectionChoices($slug: String!) {
    attribute(slug: $slug) {
      slug
      choices(first: 100) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  }
`);

export type CableNamesQuery = {
  productVariants?: {
    edges: Array<{
      node: {
        id: string;
        name: string;
        translation?: { name?: string | null } | null;
        product: { name: string; translation?: { name?: string | null } | null };
      };
    }>;
  } | null;
};

export type CableNamesQueryVariables = {
  ids: string[];
  channel: string;
  /** ALWAYS sent (Saleor rejects an omitted non-null variable); only read when `tr` is true, so any valid code works then */
  lang: string;
  tr: boolean;
};

/**
 * Saleor's labels for the base variant and the selected components, in the
 * checkout's language (the storefront configurator's rule: translation first,
 * base name as fallback). Without a checkout language `tr` is false and only
 * the base names are returned. One malformed ID makes Saleor reject the whole
 * query, so callers treat an error as "names unavailable" and fail closed.
 */
export const CableNamesDocument: TypedDocumentNode<CableNamesQuery, CableNamesQueryVariables> = parse(`
  query CableNames($ids: [ID!]!, $channel: String!, $lang: LanguageCodeEnum!, $tr: Boolean!) {
    productVariants(first: 100, ids: $ids, channel: $channel) {
      edges {
        node {
          id
          name
          translation(languageCode: $lang) @include(if: $tr) {
            name
          }
          product {
            name
            translation(languageCode: $lang) @include(if: $tr) {
              name
            }
          }
        }
      }
    }
  }
`);

export type CableLineKindQuery = {
  checkout?: {
    id: string;
    lines: Array<{
      id: string;
      privateMetadata: Array<{ key: string }>;
      variant: { id: string; product: { slug: string } };
    }>;
  } | null;
};

export type CableLineKindQueryVariables = { id: string };

/**
 * What a checkout line IS, from data a shopper cannot write: its product slug
 * and its private metadata (update-line-quantity, L4).
 */
export const CableLineKindDocument: TypedDocumentNode<CableLineKindQuery, CableLineKindQueryVariables> = parse(`
  query CableLineKind($id: ID!) {
    checkout(id: $id) {
      id
      lines {
        id
        privateMetadata {
          key
        }
        variant {
          id
          product {
            slug
          }
        }
      }
    }
  }
`);

export type CableCheckoutChannelQuery = {
  checkout?: { id: string; languageCode: string; channel: { slug: string } } | null;
};

export type CableCheckoutChannelQueryVariables = { id: string };

export const CableCheckoutChannelDocument: TypedDocumentNode<
  CableCheckoutChannelQuery,
  CableCheckoutChannelQueryVariables
> = parse(`
  query CableCheckoutChannel($id: ID!) {
    checkout(id: $id) {
      id
      languageCode
      channel {
        slug
      }
    }
  }
`);
