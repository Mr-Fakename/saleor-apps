import { readFileSync } from "fs";
import { buildSchema, type DocumentNode, validate } from "graphql";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  CableBaseVariantDocument,
  CableCheckoutChannelDocument,
  CableOptionProductsDocument,
} from "../modules/cable/cable-documents";
import { PaymentFeeCheckoutDocument } from "../modules/payment-fee/payment-fee-checkout-query";

/**
 * The inline documents bypass graphql-codegen, so nothing else checks them
 * against the Saleor schema. This does (graphql/schema.graphql, the same file
 * codegen uses).
 */
const schema = buildSchema(readFileSync(path.resolve(__dirname, "..", "..", "graphql", "schema.graphql"), "utf8"));

const documents: Record<string, DocumentNode> = {
  PaymentFeeCheckout: PaymentFeeCheckoutDocument,
  CableBaseVariant: CableBaseVariantDocument,
  CableOptionProducts: CableOptionProductsDocument,
  CableCheckoutChannel: CableCheckoutChannelDocument,
};

describe("inline GraphQL documents", () => {
  it.each(Object.entries(documents))("%s is valid against the Saleor schema", (_name, document) => {
    expect(validate(schema, document).map((error) => error.message)).toStrictEqual([]);
  });
});
