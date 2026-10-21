// @vitest-environment node
/**
 * Route allowlist contract (regression NR-05: debug / test / setup routes shipped in an app).
 *
 * Every HTTP endpoint this app exposes must be listed here. Adding a route means adding it to
 * the allowlist in the same change, so a reviewer sees it. Never allowlist debug, test or setup
 * routes: they were removed because they were unauthenticated (APL dumps, table creation).
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const APP_ROOT = path.resolve(__dirname, "../../..");
const APP_DIR = path.join(APP_ROOT, "src", "app");

const ALLOWED_ROUTES = [
  "src/app/api/downloads/[token]/route.ts",
  "src/app/api/manifest/route.ts",
  "src/app/api/orders/[orderId]/downloads/route.ts",
  "src/app/api/register/route.ts",
  "src/app/api/webhooks/saleor/order-fully-paid/route.ts",
];

const ROUTE_HANDLER_FILE = /(^|\/)route\.(ts|tsx|js|jsx|mjs)$/;

const toPosix = (p: string) => p.split(path.sep).join("/");

const findRouteHandlers = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map(toPosix)
    .filter((relativePath) => ROUTE_HANDLER_FILE.test(relativePath))
    .map((relativePath) => toPosix(path.relative(APP_ROOT, path.join(dir, relativePath))))
    .sort();

describe("API route allowlist (NR-05)", () => {
  it("exposes exactly the allowlisted App Router route handlers", () => {
    expect(findRouteHandlers(APP_DIR)).toStrictEqual([...ALLOWED_ROUTES].sort());
  });

  it("has no Pages Router API routes (they would bypass this allowlist)", () => {
    expect(existsSync(path.join(APP_ROOT, "src", "pages"))).toBe(false);
    expect(existsSync(path.join(APP_ROOT, "pages"))).toBe(false);
  });
});
