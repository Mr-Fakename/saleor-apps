import { SALEOR_API_URL_HEADER, SALEOR_AUTHORIZATION_BEARER_HEADER } from "@saleor/app-sdk/headers";
import { getAppBaseUrl } from "@saleor/apps-shared/get-app-base-url";
import { inferAsyncReturnType } from "@trpc/server";
import * as trpcNext from "@trpc/server/adapters/next";

import { WishlistRepo } from "@/modules/wishlists/repositories/wishlist-repo";
import { ReviewRepo } from "@/modules/reviews/repositories/review-repo";
import { SaleorClient } from "@/modules/saleor/saleor-client";
import { PurchaseVerifier } from "@/modules/reviews/services/purchase-verifier";

export const createTrpcContextPagesRouter = async ({ req }: trpcNext.CreateNextContextOptions) => {
  const baseUrl = getAppBaseUrl(req.headers);

  return {
    token: req.headers[SALEOR_AUTHORIZATION_BEARER_HEADER] as string | undefined,
    saleorApiUrl: req.headers[SALEOR_API_URL_HEADER] as string | undefined,
    appId: undefined as undefined | string,
    appToken: undefined as undefined | string,
    appUrl: baseUrl,
    userId: undefined as undefined | string,
    isStaff: undefined as undefined | boolean,
    wishlistRepo: undefined as undefined | WishlistRepo,
    reviewRepo: undefined as undefined | ReviewRepo,
    saleorClient: undefined as undefined | SaleorClient,
    purchaseVerifier: undefined as undefined | PurchaseVerifier,
    ssr: undefined as undefined | boolean,
    baseUrl,
  };
};

export type TrpcContextPagesRouter = inferAsyncReturnType<typeof createTrpcContextPagesRouter>;
