import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { MicroinvoiceInvoiceGenerator } from "./microinvoice-invoice-generator";
import { readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import rimraf from "rimraf";
import { mockOrder } from "../../../../fixtures/mock-order";
import { getMockAddress } from "../../../../fixtures/mock-address";

// Default so the module still LOADS in CI: the it.runIf below skips the test
// there, but a bare join(undefined, ...) at module level crashed collection
// before the skip could apply.
const dirToSet = process.env.TEMP_PDF_STORAGE_DIR ?? join(tmpdir(), "invoices-microinvoice-test");
const filePath = join(dirToSet, "test-invoice.pdf");

const cleanup = () => rimraf.sync(filePath);

describe("MicroinvoiceInvoiceGenerator", () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  /**
   * For some reason it fails in Github Actions
   * @todo fixme
   */
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  it.runIf(process.env.CI !== "true")("Generates invoice file from Order", async () => {
    const instance = new MicroinvoiceInvoiceGenerator();

    await instance.generate({
      order: mockOrder,
      filename: filePath,
      invoiceNumber: "test-123/123",
      companyAddressData: getMockAddress(),
    });

    return expect(readFile(filePath)).resolves.toBeDefined();
  });
});
