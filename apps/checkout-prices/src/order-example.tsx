import { actions, useAppBridge } from "@saleor/app-sdk/app-bridge";
import { Box, Text } from "@saleor/macaw-ui/next";
import React from "react";
import { useLastOrderQuery } from "../generated/graphql";
import gql from "graphql-tag";
import Link from "next/link";
import { useTranslations } from "./lib/i18n";

/**
 * GraphQL Code Generator scans for gql tags and generates types based on them.
 * The below query is used to generate the "useLastOrderQuery" hook.
 * If you modify it, make sure to run "pnpm codegen" to regenerate the types.
 */
gql`
  query LastOrder {
    orders(first: 1) {
      edges {
        node {
          id
          number
          created
          user {
            firstName
            lastName
          }
          shippingAddress {
            country {
              country
            }
          }
          total {
            gross {
              amount
              currency
            }
          }
          lines {
            id
          }
        }
      }
    }
  }
`;

function generateNumberOfLinesText(lines: any[], t: ReturnType<typeof useTranslations>) {
  if (lines.length === 0) {
    return t.order.noLines;
  }

  if (lines.length === 1) {
    return t.order.containsLine;
  }

  return t.order.containsLines.replace("{count}", String(lines.length));
}

export const OrderExample = () => {
  const { appBridge } = useAppBridge();
  const t = useTranslations();

  // Using the generated hook
  const [{ data, fetching }] = useLastOrderQuery();
  const lastOrder = data?.orders?.edges[0]?.node;

  const navigateToOrder = (id: string) => {
    appBridge?.dispatch(
      actions.Redirect({
        to: `/orders/${id}`,
      })
    );
  };

  return (
    <Box display="flex" flexDirection={"column"} gap={2}>
      <Text as={"h2"} variant={"heading"}>
        {t.order.fetchingData}
      </Text>

      <>
        {fetching && <Text color="textNeutralSubdued">{t.order.fetchingLastOrder}</Text>}
        {lastOrder && (
          <>
            <Text color="textNeutralSubdued">
              {t.order.permissionInfo}
            </Text>
            <Box
              backgroundColor={"subdued"}
              padding={4}
              borderRadius={4}
              borderWidth={1}
              borderStyle={"solid"}
              borderColor={"neutralDefault"}
              marginY={4}
            >
              <Text>{t.order.lastOrder.replace("{number}", lastOrder.number)}</Text>
              <ul>
                <li>
                  <Text>{generateNumberOfLinesText(lastOrder.lines, t)} 🛒</Text>
                </li>
                <li>
                  <Text>
                    {t.order.totalAmount
                      .replace("{amount}", String(lastOrder.total.gross.amount))
                      .replace("{currency}", lastOrder.total.gross.currency)} 💸
                  </Text>
                </li>
                <li>
                  <Text>
                    {t.order.shipsTo.replace("{country}", lastOrder.shippingAddress?.country.country || "N/A")} 📦
                  </Text>
                </li>
              </ul>
              <Link onClick={() => navigateToOrder(lastOrder.id)} href={`/orders/${lastOrder.id}`}>
                {t.order.seeOrderDetails} →
              </Link>
            </Box>
          </>
        )}
        {!fetching && !lastOrder && <Text color="textNeutralSubdued">{t.order.noOrdersFound}</Text>}
      </>
    </Box>
  );
};
