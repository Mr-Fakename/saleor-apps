import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../modules/vies/vies-client", () => ({
  checkVat: vi.fn(),
}));

vi.mock("../../modules/vies/vies-cache", () => ({
  getCachedResult: vi.fn().mockReturnValue(null),
  setCachedResult: vi.fn(),
}));

import { NextApiRequest, NextApiResponse } from "next";
import { ok, err } from "neverthrow";

describe("validate-vat API", () => {
  let req: Partial<NextApiRequest>;
  let res: Partial<NextApiResponse>;
  let jsonFn: ReturnType<typeof vi.fn>;
  let statusFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    jsonFn = vi.fn().mockReturnThis();
    statusFn = vi.fn().mockReturnValue({ json: jsonFn, end: vi.fn() });
    req = {
      method: "POST",
      headers: { "x-api-key": "test-key" },
      body: {
        vatNumber: "DE123456789",
        checkoutId: "checkout-1",
        countryCode: "DE",
        billingCountryCode: "DE",
        shippingCountryCode: "DE",
        companyName: "Test GmbH",
      },
    };
    res = { status: statusFn, json: jsonFn };
    process.env.B2B_TAX_MANAGER_API_KEY = "test-key";
  });

  it("returns 401 without API key", async () => {
    const handler = (await import("../../pages/api/validate-vat")).default;
    req.headers = {};
    await handler(req as NextApiRequest, res as NextApiResponse);
    expect(statusFn).toHaveBeenCalledWith(401);
  });

  it("returns 400 with invalid body", async () => {
    const handler = (await import("../../pages/api/validate-vat")).default;
    req.body = {};
    await handler(req as NextApiRequest, res as NextApiResponse);
    expect(statusFn).toHaveBeenCalledWith(400);
  });

  it("returns 405 for non-POST methods", async () => {
    const handler = (await import("../../pages/api/validate-vat")).default;
    req.method = "GET";
    await handler(req as NextApiRequest, res as NextApiResponse);
    expect(statusFn).toHaveBeenCalledWith(405);
  });

  it("denies when company name is missing", async () => {
    const handler = (await import("../../pages/api/validate-vat")).default;
    req.body = { ...req.body, companyName: "" };
    await handler(req as NextApiRequest, res as NextApiResponse);
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({
      denied: "COMPANY_NAME_MISSING",
      taxExempt: false,
    }));
  });

  it("exempts intra-EU with matching billing + foreign shipping", async () => {
    const { checkVat } = await import("../../modules/vies/vies-client");
    (checkVat as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({
        valid: true,
        countryCode: "DE",
        vatNumber: "123456789",
        requestDate: "2026-03-25",
        name: "Test GmbH",
        address: "Berlin",
      }),
    );
    const handler = (await import("../../pages/api/validate-vat")).default;
    await handler(req as NextApiRequest, res as NextApiResponse);
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({
      valid: true,
      taxExempt: true,
      taxExemptReason: "INTRA_EU_REVERSE_CHARGE",
    }));
  });

  it("denies when billing country mismatches VAT country", async () => {
    const { checkVat } = await import("../../modules/vies/vies-client");
    (checkVat as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({
        valid: true,
        countryCode: "DE",
        vatNumber: "123456789",
        requestDate: "2026-03-25",
        name: "Test GmbH",
        address: "Berlin",
      }),
    );
    req.body = { ...req.body, billingCountryCode: "FR" };
    const handler = (await import("../../pages/api/validate-vat")).default;
    await handler(req as NextApiRequest, res as NextApiResponse);
    expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({
      valid: true,
      taxExempt: false,
      denied: "BILLING_COUNTRY_MISMATCH",
    }));
  });

  it("denies when shipping to seller country (FR)", async () => {
    const { checkVat } = await import("../../modules/vies/vies-client");
    (checkVat as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({
        valid: true,
        countryCode: "DE",
        vatNumber: "123456789",
        requestDate: "2026-03-25",
        name: "Test GmbH",
        address: "Berlin",
      }),
    );
    req.body = { ...req.body, shippingCountryCode: "FR" };
    const handler = (await import("../../pages/api/validate-vat")).default;
    await handler(req as NextApiRequest, res as NextApiResponse);
    expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({
      valid: true,
      taxExempt: false,
      denied: "DOMESTIC_DELIVERY",
    }));
  });

  it("returns error when VIES is unavailable", async () => {
    const { checkVat } = await import("../../modules/vies/vies-client");
    (checkVat as ReturnType<typeof vi.fn>).mockResolvedValue(err("VIES_UNAVAILABLE"));
    const handler = (await import("../../pages/api/validate-vat")).default;
    await handler(req as NextApiRequest, res as NextApiResponse);
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({
      valid: null,
      error: "VIES_UNAVAILABLE",
      taxExempt: false,
    }));
  });
});
