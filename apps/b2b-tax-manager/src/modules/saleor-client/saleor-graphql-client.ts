import { createLogger } from "../../logger";

const logger = createLogger("SaleorGraphqlClient");

export interface SaleorGraphqlClient {
  setTaxExemption(checkoutId: string, exempt: boolean): Promise<void>;
  updateCheckoutMetadata(checkoutId: string, metadata: Array<{ key: string; value: string }>): Promise<void>;
  updateOrderMetadata(orderId: string, metadata: Array<{ key: string; value: string }>): Promise<void>;
  updateUserPrivateMetadata(userId: string, metadata: Array<{ key: string; value: string }>): Promise<void>;
}

interface GraphqlResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

export function createSaleorClient(saleorApiUrl: string, token: string): SaleorGraphqlClient {
  async function executeGraphql(query: string, variables: Record<string, unknown>): Promise<GraphqlResponse> {
    const response = await fetch(saleorApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`Saleor API error: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as GraphqlResponse;

    if (json.errors?.length) {
      logger.error("GraphQL errors", { errors: json.errors });
      throw new Error(`GraphQL error: ${json.errors[0].message}`);
    }

    return json;
  }

  return {
    async setTaxExemption(checkoutId: string, exempt: boolean): Promise<void> {
      const mutation = `
        mutation TaxExemptionManage($id: ID!, $taxExemption: Boolean!) {
          taxExemptionManage(id: $id, taxExemption: $taxExemption) {
            errors {
              field
              message
            }
          }
        }
      `;

      const result = await executeGraphql(mutation, { id: checkoutId, taxExemption: exempt });
      const errors = (result.data?.taxExemptionManage as { errors?: Array<{ message: string }> })?.errors;

      if (errors?.length) {
        throw new Error(`taxExemptionManage failed: ${errors[0].message}`);
      }

      logger.info("Tax exemption set", { checkoutId, exempt });
    },

    async updateCheckoutMetadata(
      checkoutId: string,
      metadata: Array<{ key: string; value: string }>,
    ): Promise<void> {
      const mutation = `
        mutation UpdateCheckoutMetadata($id: ID!, $input: [MetadataInput!]!) {
          updateMetadata(id: $id, input: $input) {
            errors {
              field
              message
            }
          }
        }
      `;

      await executeGraphql(mutation, { id: checkoutId, input: metadata });
      logger.info("Checkout metadata updated", { checkoutId, keys: metadata.map((m) => m.key) });
    },

    async updateOrderMetadata(
      orderId: string,
      metadata: Array<{ key: string; value: string }>,
    ): Promise<void> {
      const mutation = `
        mutation UpdateOrderMetadata($id: ID!, $input: [MetadataInput!]!) {
          updateMetadata(id: $id, input: $input) {
            errors {
              field
              message
            }
          }
        }
      `;

      await executeGraphql(mutation, { id: orderId, input: metadata });
      logger.info("Order metadata updated", { orderId, keys: metadata.map((m) => m.key) });
    },

    async updateUserPrivateMetadata(
      userId: string,
      metadata: Array<{ key: string; value: string }>,
    ): Promise<void> {
      const mutation = `
        mutation UpdateUserPrivateMetadata($id: ID!, $input: [MetadataInput!]!) {
          updatePrivateMetadata(id: $id, input: $input) {
            errors {
              field
              message
            }
          }
        }
      `;

      await executeGraphql(mutation, { id: userId, input: metadata });
      logger.info("User private metadata updated", { userId, keys: metadata.map((m) => m.key) });
    },
  };
}
