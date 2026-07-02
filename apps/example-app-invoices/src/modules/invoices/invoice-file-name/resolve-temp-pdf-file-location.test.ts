import { join } from "path";
import { describe, expect, it } from "vitest";
import { resolveTempPdfFileLocation } from "./resolve-temp-pdf-file-location";

describe("resolveTempPdfFileLocation", () => {
  it("generates path with encoded file name, in case of invoice name contains path segments", async () => {
    const dirToSet = process.env.TEMP_PDF_STORAGE_DIR as string;

    // Production code builds the location with path.join, so the separator is
    // platform-dependent (`\` on Windows, `/` on POSIX). Mirror that here.
    await expect(resolveTempPdfFileLocation("12/12/2022-foobar.pdf")).resolves.toBe(
      join(dirToSet, "12%2F12%2F2022-foobar.pdf")
    );
  });
});
