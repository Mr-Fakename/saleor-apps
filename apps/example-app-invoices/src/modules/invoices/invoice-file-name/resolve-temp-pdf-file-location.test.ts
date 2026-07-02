import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTempPdfFileLocation } from "./resolve-temp-pdf-file-location";

describe("resolveTempPdfFileLocation", () => {
  // The implementation reads TEMP_PDF_STORAGE_DIR at call time; stub it so the
  // test is self-sufficient — relying on the ambient env made this pass on the
  // operator machine and crash in CI with join(undefined, …).
  const dirToSet = join(tmpdir(), "invoices-temp-pdf-test");

  beforeEach(() => {
    vi.stubEnv("TEMP_PDF_STORAGE_DIR", dirToSet);
  });

  it("generates path with encoded file name, in case of invoice name contains path segments", async () => {
    // Production code builds the location with path.join, so the separator is
    // platform-dependent (`\` on Windows, `/` on POSIX). Mirror that here.
    await expect(resolveTempPdfFileLocation("12/12/2022-foobar.pdf")).resolves.toBe(
      join(dirToSet, "12%2F12%2F2022-foobar.pdf")
    );
  });
});
