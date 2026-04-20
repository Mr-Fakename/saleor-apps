console.log("[CONST] Loading environment variables...");
console.log("[CONST] NEXT_PUBLIC_SALEOR_API_URL:", process.env.NEXT_PUBLIC_SALEOR_API_URL);
console.log("[CONST] NEXT_PUBLIC_DEFAULT_CHANNEL:", process.env.NEXT_PUBLIC_DEFAULT_CHANNEL);

export const SALEOR_API_URL = (process.env.NEXT_PUBLIC_SALEOR_API_URL || "https://saleor-api.vps.daybreakdevelopment.eu/graphql/") as string;

console.log("[CONST] Final SALEOR_API_URL:", SALEOR_API_URL);

if (!SALEOR_API_URL) {
  console.error("[CONST] ✗ NEXT_PUBLIC_SALEOR_API_URL environment variable is not set");
  throw new Error("NEXT_PUBLIC_SALEOR_API_URL environment variable is not set");
}

export const DEFAULT_CHANNEL = process.env.NEXT_PUBLIC_DEFAULT_CHANNEL as string;

if (!DEFAULT_CHANNEL) {
  console.error("[CONST] ✗ NEXT_PUBLIC_DEFAULT_CHANNEL environment variable is not set");
  throw new Error("NEXT_PUBLIC_DEFAULT_CHANNEL environment variable is not set");
}

console.log("[CONST] ✓ Environment variables loaded successfully");
