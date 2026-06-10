console.log("[CONST] Loading environment variables...");
console.log("[CONST] SALEOR_API_URL (runtime):", process.env.SALEOR_API_URL);
console.log("[CONST] NEXT_PUBLIC_SALEOR_API_URL (build-time):", process.env.NEXT_PUBLIC_SALEOR_API_URL);
console.log("[CONST] NEXT_PUBLIC_DEFAULT_CHANNEL:", process.env.NEXT_PUBLIC_DEFAULT_CHANNEL);

// Server-side code MUST prefer the runtime env (SALEOR_API_URL): NEXT_PUBLIC_*
// values are inlined into the bundle at image build time, so a published image
// silently carries whatever Saleor URL it was built against (this broke the
// staging cable configurator when the API host moved — the image kept calling
// the old, deleted host). In the browser only the baked NEXT_PUBLIC_ value
// exists, which is fine: the dashboard iframe page is cosmetic.
export const SALEOR_API_URL = (process.env.SALEOR_API_URL ||
  process.env.NEXT_PUBLIC_SALEOR_API_URL) as string;

console.log("[CONST] Final SALEOR_API_URL:", SALEOR_API_URL);

if (!SALEOR_API_URL && typeof window === "undefined") {
  console.error("[CONST] ✗ Neither SALEOR_API_URL nor NEXT_PUBLIC_SALEOR_API_URL is set");
  throw new Error("SALEOR_API_URL (or NEXT_PUBLIC_SALEOR_API_URL) environment variable is not set");
}

export const DEFAULT_CHANNEL = (process.env.DEFAULT_CHANNEL ||
  process.env.NEXT_PUBLIC_DEFAULT_CHANNEL ||
  "default-channel") as string;

console.log("[CONST] ✓ Environment variables loaded successfully");
