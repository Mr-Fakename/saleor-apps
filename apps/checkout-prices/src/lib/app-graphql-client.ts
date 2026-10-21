import { SALEOR_API_URL } from "../const";
import { apl } from "../saleor-app";
import { createClient } from "./create-graphql-client";

/**
 * urql client authenticated with the app's own Saleor token (single-tenant:
 * falls back to the only installation when the configured URL has no entry).
 */
export function createAppGraphQLClient(logPrefix: string) {
  return createClient(SALEOR_API_URL, async () => {
    let authData = await apl.get(SALEOR_API_URL);

    if (!authData) {
      const allAuth = await apl.getAll();

      if (allAuth.length > 0) {
        authData = allAuth[0];
        console.log(`[${logPrefix}] Using fallback auth data for:`, authData.saleorApiUrl);
      }
    }

    if (!authData) {
      throw new Error("No auth data found. Is the app installed?");
    }

    return { token: authData.token };
  });
}
