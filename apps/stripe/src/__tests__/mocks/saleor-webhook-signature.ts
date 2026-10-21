import { generateKeyPairSync, KeyObject, sign } from "node:crypto";

/**
 * Real Saleor-style webhook signatures for tests: RS256 detached JWS over the raw body
 * (RFC 7797, header {alg, kid, b64:false, crit:["b64"]}), the format Saleor sends in
 * `saleor-signature` and that `verifySignatureWithJwks` from `@saleor/app-sdk/auth` checks.
 */
export type SaleorSigningKeys = {
  kid: string;
  privateKey: KeyObject;
  /** JWKS JSON, as stored in AuthData.jwks and served at /.well-known/jwks.json. */
  jwks: string;
};

export const createSaleorSigningKeys = (kid = "saleor-test-kid"): SaleorSigningKeys => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });

  return {
    kid,
    privateKey,
    jwks: JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }),
  };
};

export const signSaleorWebhookBody = (rawBody: string, keys: SaleorSigningKeys) => {
  const protectedHeader = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: keys.kid, b64: false, crit: ["b64"] }),
  ).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${protectedHeader}.${rawBody}`), keys.privateKey);

  return `${protectedHeader}..${signature.toString("base64url")}`;
};
