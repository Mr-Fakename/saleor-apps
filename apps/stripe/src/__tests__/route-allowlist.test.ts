// @vitest-environment node
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Regression NR-05: the app must expose exactly the HTTP routes listed here. Debug, test
 * and setup routes (`debug-apl`, `debug-auth`, `test-apl-fix`, `test-direct-refund`, ...)
 * leaked APL contents and allowed unauthenticated actions; any new route must be added to
 * this list on purpose, in review.
 */
const ALLOWED_ROUTES = [
  "src/app/api/manifest/route.ts",
  "src/app/api/register/route.ts",
  "src/app/api/trpc/[trpc]/route.ts",
  "src/app/api/update-payment-intent/route.ts",
  "src/app/api/webhooks/saleor/payment-gateway-initialize-session/route.ts",
  "src/app/api/webhooks/saleor/transaction-cancelation-requested/route.ts",
  "src/app/api/webhooks/saleor/transaction-charge-requested/route.ts",
  "src/app/api/webhooks/saleor/transaction-initialize-session/route.ts",
  "src/app/api/webhooks/saleor/transaction-process-session/route.ts",
  "src/app/api/webhooks/saleor/transaction-refund-requested/route.ts",
  "src/app/api/webhooks/stripe/route.ts",
];

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

const listFiles = (relativeDir: string): string[] => {
  const absoluteDir = path.join(appRoot, relativeDir);

  if (!existsSync(absoluteDir)) {
    return [];
  }

  return readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = `${relativeDir}/${entry.name}`;

    return entry.isDirectory() ? listFiles(relativePath) : [relativePath];
  });
};

const ROUTE_HANDLER_FILE = /\/route\.(ts|tsx|js|jsx|mjs)$/;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/;

describe("HTTP route allowlist (NR-05)", () => {
  it("App Router exposes exactly the allowed route handlers", () => {
    const routes = listFiles("src/app")
      .filter((file) => ROUTE_HANDLER_FILE.test(file))
      .sort();

    expect(routes).toStrictEqual([...ALLOWED_ROUTES].sort());
  });

  it("Pages Router exposes no API routes", () => {
    const pagesApiRoutes = listFiles("src/pages/api").filter(
      (file) => SOURCE_FILE.test(file) && !TEST_FILE.test(file),
    );

    expect(pagesApiRoutes).toStrictEqual([]);
  });

  it("no route path looks like a debug, test or setup endpoint", () => {
    const suspicious = listFiles("src/app")
      .concat(listFiles("src/pages"))
      .filter((file) => !TEST_FILE.test(file))
      .filter((file) => /\/(debug|test|setup)[^/]*\//i.test(file.replace(/^src\//, "/")));

    expect(suspicious).toStrictEqual([]);
  });
});
