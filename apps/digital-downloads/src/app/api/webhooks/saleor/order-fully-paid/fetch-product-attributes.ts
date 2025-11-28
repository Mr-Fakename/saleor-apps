import { err, ok, Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { createInstrumentedGraphqlClient } from "@/lib/graphql-client";
import {
  GetProductAttributesDocument,
  GetProductAttributesQuery,
  GetProductAttributesQueryVariables,
} from "@/generated/graphql";

const logger = createLogger("fetchProductAttributes");

export const FetchProductAttributesErrors = {
  GraphQLError: BaseError.subclass("GraphQLError", {
    props: {
      _brand: "fetchProductAttributes.GraphQLError" as const,
    },
  }),
  ProductNotFoundError: BaseError.subclass("ProductNotFoundError", {
    props: {
      _brand: "fetchProductAttributes.ProductNotFoundError" as const,
    },
  }),
};

export type FetchProductAttributesError =
  | InstanceType<typeof FetchProductAttributesErrors.GraphQLError>
  | InstanceType<typeof FetchProductAttributesErrors.ProductNotFoundError>;

export interface ProductAttributeData {
  attribute: {
    id: string;
    name: string;
    slug: string;
  };
  values: Array<{
    id: string;
    name: string;
    slug: string;
    file: {
      url: string;
      contentType: string | null;
    } | null;
  }>;
}

/**
 * Fetches product attributes directly from Saleor API
 * This is necessary because webhooks don't reliably include FILE-type attributes
 */
export async function fetchProductAttributes(
  saleorApiUrl: string,
  authToken: string,
  productId: string,
): Promise<Result<ProductAttributeData[], FetchProductAttributesError>> {
  try {
    logger.debug("Fetching product file attributes from Saleor API", {
      productId,
    });

    const client = createInstrumentedGraphqlClient({
      saleorApiUrl,
      token: authToken,
    });

    const result = await client
      .query<GetProductAttributesQuery, GetProductAttributesQueryVariables>(
        GetProductAttributesDocument,
        { productId },
      )
      .toPromise();

    if (result.error) {
      logger.error("GraphQL error fetching product attributes", {
        error: result.error,
        productId,
      });

      return err(
        new FetchProductAttributesErrors.GraphQLError("Failed to fetch product attributes", {
          cause: result.error,
        }),
      );
    }

    if (!result.data?.product) {
      logger.warn("Product not found", { productId });

      return err(
        new FetchProductAttributesErrors.ProductNotFoundError("Product not found", {
          cause: { productId },
        }),
      );
    }

    const product = result.data.product;

    // Collect all file attributes from the assignedAttribute fields
    // These are queried separately (files, files_2, files_3, etc.) for reliability
    const attributes: ProductAttributeData[] = [];

    // Helper to add a file attribute if it exists
    const addFileAttribute = (fileAttr: any, partNumber: number) => {
      if (fileAttr?.attribute && fileAttr?.value?.url) {
        // Convert single value to values array format for compatibility
        attributes.push({
          attribute: {
            id: fileAttr.attribute.id,
            name: fileAttr.attribute.name || fileAttr.attribute.slug,
            slug: fileAttr.attribute.slug,
          },
          values: [{
            id: `${fileAttr.attribute.id}-value`,
            name: fileAttr.value.url.split("/").pop() || `File Part ${partNumber}`,
            slug: fileAttr.attribute.slug,
            file: {
              url: fileAttr.value.url,
              contentType: fileAttr.value.contentType || null,
            },
          }],
        });
      }
    };

    // Collect all file parts
    addFileAttribute(product.files, 1);
    addFileAttribute(product.files_2, 2);
    addFileAttribute(product.files_3, 3);
    addFileAttribute(product.files_4, 4);
    addFileAttribute(product.files_5, 5);

    logger.info("Successfully fetched product file attributes", {
      productId,
      productName: product.name,
      fileAttributesCount: attributes.length,
      files: attributes.flatMap(attr =>
        attr.values
          .filter(v => v.file?.url)
          .map(v => ({ name: v.name, url: v.file!.url }))
      ),
    });

    return ok(attributes);
  } catch (error) {
    logger.error("Unexpected error fetching product attributes", {
      error,
      productId,
    });

    return err(
      new FetchProductAttributesErrors.GraphQLError("Unexpected error occurred", {
        cause: error,
      }),
    );
  }
}
