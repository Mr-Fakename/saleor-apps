import { type inferAsyncReturnType } from "@trpc/server";
import { type CreateNextContextOptions } from "@trpc/server/adapters/next";
import { SALEOR_API_URL_HEADER, SALEOR_AUTHORIZATION_BEARER_HEADER } from "@saleor/app-sdk/headers";

export async function createTrpcContext({ req }: CreateNextContextOptions) {
  const saleorApiUrl = req.headers[SALEOR_API_URL_HEADER] as string | undefined;
  const token = req.headers[SALEOR_AUTHORIZATION_BEARER_HEADER] as string | undefined;

  return {
    saleorApiUrl: saleorApiUrl ?? null,
    token: token ?? null,
  };
}

export type TrpcContext = inferAsyncReturnType<typeof createTrpcContext>;
