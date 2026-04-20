import { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";
import { createLogger } from "../../logger";
import { checkVat } from "../../modules/vies/vies-client";
import { getCachedResult, setCachedResult } from "../../modules/vies/vies-cache";
import { ViesValidationResult } from "../../modules/vies/vies-types";
import { validateVatFormat } from "../../modules/vat-validation/vat-patterns";
import { evaluateTaxExemption } from "../../modules/tax-exemption/eu-country-rules";

const logger = createLogger("validate-vat");

const requestSchema = z.object({
  vatNumber: z.string().min(4).max(15).regex(/^[A-Za-z0-9\s.\-]+$/),
  checkoutId: z.string().min(1),
  countryCode: z.string().length(2).regex(/^[A-Za-z]{2}$/),
  billingCountryCode: z.string().length(2).regex(/^[A-Za-z]{2}$/).optional(),
  shippingCountryCode: z.string().length(2).regex(/^[A-Za-z]{2}$/).optional(),
  companyName: z.string().optional(),
});

interface ValidateVatResponse {
  valid: boolean | null;
  companyName: string | null;
  companyAddress: string | null;
  requestDate: string;
  cached: boolean;
  error: string | null;
  taxExempt: boolean;
  taxExemptReason: string;
  denied?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  // Auth check
  const apiKey = req.headers["x-api-key"] as string | undefined;
  const expectedKey = process.env.B2B_TAX_MANAGER_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  // Parse and validate body
  const parseResult = requestSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      details: parseResult.error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      })),
    });
  }

  const { vatNumber, countryCode, billingCountryCode, shippingCountryCode, companyName } = parseResult.data;
  const cleanVat = vatNumber.replace(/[\s.\-]/g, "").toUpperCase();

  // Anti-fraud #3: Company name is required for B2B
  if (!companyName || companyName.trim().length < 2) {
    return res.status(200).json({
      valid: false,
      companyName: null,
      companyAddress: null,
      requestDate: new Date().toISOString().split("T")[0],
      cached: false,
      error: null,
      taxExempt: false,
      taxExemptReason: "",
      denied: "COMPANY_NAME_MISSING",
    } satisfies ValidateVatResponse);
  }

  // Client-side format check
  const formatCheck = validateVatFormat(cleanVat);
  if (!formatCheck.valid) {
    const exemption = evaluateTaxExemption(countryCode, false, billingCountryCode, shippingCountryCode);
    return res.status(200).json({
      valid: false,
      companyName: null,
      companyAddress: null,
      requestDate: new Date().toISOString().split("T")[0],
      cached: false,
      error: null,
      taxExempt: exemption.exempt,
      taxExemptReason: exemption.reason,
      denied: exemption.denied,
    } satisfies ValidateVatResponse);
  }

  const resolvedCountry = formatCheck.countryCode ?? countryCode.toUpperCase();

  // Check cache
  const cached = getCachedResult(resolvedCountry, cleanVat);
  if (cached) {
    logger.info("Returning cached VIES result", { countryCode: resolvedCountry });
    const exemption = evaluateTaxExemption(resolvedCountry, cached.valid === true, billingCountryCode, shippingCountryCode);
    return res.status(200).json({
      ...cached,
      taxExempt: exemption.exempt,
      taxExemptReason: exemption.reason,
      denied: exemption.denied,
    } satisfies ValidateVatResponse);
  }

  // Call VIES
  const viesResult = await checkVat(resolvedCountry, cleanVat);

  if (viesResult.isErr()) {
    const errorCode = viesResult.error;
    logger.warn("VIES validation failed", { errorCode, countryCode: resolvedCountry });

    return res.status(200).json({
      valid: null,
      companyName: null,
      companyAddress: null,
      requestDate: new Date().toISOString().split("T")[0],
      cached: false,
      error: errorCode,
      taxExempt: false,
      taxExemptReason: "",
    } satisfies ValidateVatResponse);
  }

  const viesData = viesResult.value;

  const validationResult: ViesValidationResult = {
    valid: viesData.valid,
    companyName: viesData.name || null,
    companyAddress: viesData.address || null,
    requestDate: viesData.requestDate,
    cached: false,
    error: null,
  };

  // Cache the result
  setCachedResult(resolvedCountry, cleanVat, validationResult);

  // Compute exemption with all anti-fraud checks
  const exemption = evaluateTaxExemption(resolvedCountry, viesData.valid, billingCountryCode, shippingCountryCode);

  logger.info("VAT validated", {
    countryCode: resolvedCountry,
    billingCountryCode,
    shippingCountryCode,
    valid: viesData.valid,
    taxExempt: exemption.exempt,
    taxExemptReason: exemption.reason,
    denied: exemption.denied,
  });

  return res.status(200).json({
    ...validationResult,
    taxExempt: exemption.exempt,
    taxExemptReason: exemption.reason,
    denied: exemption.denied,
  } satisfies ValidateVatResponse);
}
