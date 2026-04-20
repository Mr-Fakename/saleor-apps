import { SALEOR_API_URL_HEADER, SALEOR_AUTHORIZATION_BEARER_HEADER } from "@saleor/app-sdk/headers";
import { httpBatchLink } from "@trpc/client";
import { createTRPCNext } from "@trpc/next";

import { appBridgeInstance } from "../../pages/_app";
import { type AppRouter } from "./trpc-app-router";

function getBaseUrl() {
  if (typeof window !== "undefined") return "";
  return `http://localhost:${process.env.PORT ?? 3001}`;
}

export const trpcClient = createTRPCNext<AppRouter>({
  config() {
    return {
      links: [
        httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          headers() {
            const { token, saleorApiUrl } = appBridgeInstance?.getState() || {};

            return {
              [SALEOR_AUTHORIZATION_BEARER_HEADER]: token ?? "",
              [SALEOR_API_URL_HEADER]: saleorApiUrl ?? "",
            };
          },
        }),
      ],
      queryClientConfig: { defaultOptions: { queries: { refetchOnWindowFocus: false } } },
    };
  },
  ssr: false,
});
