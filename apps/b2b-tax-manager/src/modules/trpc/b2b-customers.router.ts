import { z } from "zod";
import { router, procedure } from "./trpc-server";
import { createLogger } from "../../logger";
import { createSaleorClient } from "../saleor-client/saleor-graphql-client";
import { checkVat } from "../vies/vies-client";

const logger = createLogger("b2b-customers-router");

export const b2bCustomersRouter = router({
  list: procedure
    .input(
      z.object({
        cursor: z.string().optional(),
        first: z.number().min(1).max(100).default(20),
      }),
    )
    .query(async ({ input, ctx }) => {
      if (!ctx.saleorApiUrl || !ctx.token) {
        throw new Error("Unauthorized: missing Saleor credentials");
      }

      // Query customers with b2b_is_business metadata via GraphQL
      const query = `
        query GetCustomers($first: Int!, $after: String) {
          customers(
            first: $first
            after: $after
            filter: { metadata: [{ key: "b2b_is_business", value: "true" }] }
          ) {
            edges {
              node {
                id
                email
                firstName
                lastName
                privateMetadata {
                  key
                  value
                }
                metadata {
                  key
                  value
                }
                defaultBillingAddress {
                  companyName
                  country { code }
                }
              }
              cursor
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;

      const response = await fetch(ctx.saleorApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.token}`,
        },
        body: JSON.stringify({
          query,
          variables: { first: input.first, after: input.cursor },
        }),
      });

      const json = await response.json();
      const data = json.data?.customers;

      if (!data) {
        logger.error("Failed to fetch customers", { errors: json.errors });
        return { customers: [], pageInfo: { hasNextPage: false, endCursor: null } };
      }

      const customers = data.edges.map((edge: any) => {
        const node = edge.node;
        const getMeta = (key: string) =>
          [...(node.privateMetadata ?? []), ...(node.metadata ?? [])].find(
            (m: { key: string }) => m.key === key,
          )?.value ?? null;

        return {
          id: node.id,
          email: node.email,
          firstName: node.firstName,
          lastName: node.lastName,
          companyName: node.defaultBillingAddress?.companyName ?? null,
          country: node.defaultBillingAddress?.country?.code ?? null,
          vatNumber: getMeta("b2b_vat_number"),
          vatValidated: getMeta("b2b_vat_validated") === "true",
          vatCountry: getMeta("b2b_vat_country"),
        };
      });

      return {
        customers,
        pageInfo: {
          hasNextPage: data.pageInfo.hasNextPage,
          endCursor: data.pageInfo.endCursor,
        },
      };
    }),

  markAsB2B: procedure
    .input(
      z.object({
        userId: z.string(),
        vatNumber: z.string().min(4).max(15),
        countryCode: z.string().length(2),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (!ctx.saleorApiUrl || !ctx.token) {
        throw new Error("Unauthorized");
      }

      const client = createSaleorClient(ctx.saleorApiUrl, ctx.token);

      // Validate via VIES
      const viesResult = await checkVat(input.countryCode, input.vatNumber);
      const isValid = viesResult.isOk() && viesResult.value.valid;

      // Update user privateMetadata
      await client.updateUserPrivateMetadata(input.userId, [
        { key: "b2b_is_business", value: "true" },
        { key: "b2b_vat_number", value: input.vatNumber.toUpperCase() },
        { key: "b2b_vat_validated", value: String(isValid) },
        { key: "b2b_vat_validated_at", value: new Date().toISOString() },
        { key: "b2b_vat_country", value: input.countryCode.toUpperCase() },
        {
          key: "b2b_company_legal_name",
          value: viesResult.isOk() ? (viesResult.value.name || "") : "",
        },
      ]);

      return {
        success: true,
        vatValid: isValid,
        companyName: viesResult.isOk() ? viesResult.value.name : null,
      };
    }),

  revokeB2B: procedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.saleorApiUrl || !ctx.token) {
        throw new Error("Unauthorized");
      }

      const client = createSaleorClient(ctx.saleorApiUrl, ctx.token);

      await client.updateUserPrivateMetadata(input.userId, [
        { key: "b2b_is_business", value: "false" },
      ]);

      return { success: true };
    }),
});
