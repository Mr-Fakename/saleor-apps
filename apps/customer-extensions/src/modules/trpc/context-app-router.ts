import { SALEOR_API_URL_HEADER, SALEOR_AUTHORIZATION_BEARER_HEADER } from "@saleor/app-sdk/headers";
import { inferAsyncReturnType } from "@trpc/server";
import { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";

import { WishlistRepo } from "@/modules/wishlists/repositories/wishlist-repo";
import { ReviewRepo } from "@/modules/reviews/repositories/review-repo";
import { SaleorClient } from "@/modules/saleor/saleor-client";
import { PurchaseVerifier } from "@/modules/reviews/services/purchase-verifier";

export const createTrpcContextAppRouter = async ({ req }: FetchCreateContextFnOptions) => {
  return {
    token: req.headers.get(SALEOR_AUTHORIZATION_BEARER_HEADER) as string | undefined,
    saleorApiUrl: req.headers.get(SALEOR_API_URL_HEADER) as string | undefined,
    appId: undefined as undefined | string,
    appToken: undefined as undefined | string,
    appUrl: req.headers.get("origin"),
    userId: undefined as undefined | string,
    isStaff: undefined as undefined | boolean,
    wishlistRepo: undefined as undefined | WishlistRepo,
    reviewRepo: undefined as undefined | ReviewRepo,
    saleorClient: undefined as undefined | SaleorClient,
    purchaseVerifier: undefined as undefined | PurchaseVerifier,
  };
};

export type TrpcContextAppRouter = inferAsyncReturnType<typeof createTrpcContextAppRouter>;
