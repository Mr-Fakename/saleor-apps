import { readFileSync } from "fs";
import { buildSchema, type DocumentNode, Kind, validate } from "graphql";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  CableBaseVariantDocument,
  CableCheckoutChannelDocument,
  CableDirectionChoicesDocument,
  CableLineKindDocument,
  CableLineMarkerDocument,
  CableNamesDocument,
  type CableNamesQueryVariables,
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
  CableDirectionChoices: CableDirectionChoicesDocument,
  CableLineKind: CableLineKindDocument,
  CableLineMarker: CableLineMarkerDocument,
  CableNames: CableNamesDocument,
};

describe("inline GraphQL documents", () => {
  it.each(Object.entries(documents))("%s is valid against the Saleor schema", (_name, document) => {
    expect(validate(schema, document).map((error) => error.message)).toStrictEqual([]);
  });

  // Saleor's engine (graphql-core 2) rejects a request that omits a NON-NULL variable even when
  // it has a default; modern graphql-js accepts it, so the fake Saleor cannot catch this.
  it.each(Object.entries(documents))("%s declares no non-null variable with a default value", (_name, document) => {
    const offenders = document.definitions.flatMap((definition) =>
      definition.kind === Kind.OPERATION_DEFINITION
        ? (definition.variableDefinitions ?? [])
            .filter((variable) => variable.type.kind === Kind.NON_NULL_TYPE && variable.defaultValue !== undefined)
            .map((variable) => variable.variable.name.value)
        : [],
    );

    expect(offenders).toStrictEqual([]);
  });

  it("CableNames requires `lang` in its variable type", () => {
    // @ts-expect-error lang is mandatory: callers must always pass it
    const missing: CableNamesQueryVariables = { ids: [], channel: "c", tr: false };

    expect(missing).toBeDefined();
  });
});
