import { existsSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Route-allowlist contract (regression NR-05).
 *
 * Every file under src/pages/api (and src/app/api route handlers) is a PUBLIC,
 * unauthenticated HTTP endpoint once deployed. An unauthenticated
 * /api/setup-db that created DynamoDB tables lived here unnoticed; this test
 * makes adding (or resurrecting) a route a deliberate, reviewed change.
 *
 * Adding a route? Add it below AND make sure it has auth/validation suited to
 * a public endpoint (CORS policy: src/lib/cors.ts).
 */
const ALLOWED_API_ROUTES = [
  "src/pages/api/add-configured-cable.ts",
  "src/pages/api/add-to-cart.ts",
  "src/pages/api/manifest.ts",
  "src/pages/api/payment-fee.ts",
  "src/pages/api/register.ts",
  "src/pages/api/update-line-quantity.ts",
];

const APP_ROOT = path.resolve(__dirname, "..", "..");

function listFiles(relativeDir: string): string[] {
  const absoluteDir = path.join(APP_ROOT, relativeDir);

  if (!existsSync(absoluteDir)) {
    return [];
  }

  return readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${relativeDir}/${entry.name}`;

    return entry.isDirectory() ? listFiles(relative) : [relative];
  });
}

describe("API route allowlist (NR-05)", () => {
  it("exposes exactly the reviewed Pages Router API routes", () => {
    expect(listFiles("src/pages/api").sort()).toStrictEqual([...ALLOWED_API_ROUTES].sort());
  });

  it("exposes no App Router route handlers", () => {
    const appRoutes = listFiles("src/app/api").filter((file) => /\/route\.[jt]sx?$/.test(file));

    expect(appRoutes).toStrictEqual([]);
  });
});
