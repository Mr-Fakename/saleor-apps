import { createLogger } from "../../logger";
import { evaluateTaxExemption, TaxExemptionResult } from "./eu-country-rules";
import { SaleorGraphqlClient } from "../saleor-client/saleor-graphql-client";

const logger = createLogger("TaxExemptionUseCase");

export interface TaxExemptionInput {
  checkoutId: string;
  billingCountryCode: string;
  vatNumber: string | null;
  vatValidated: boolean;
}

export interface TaxExemptionOutput extends TaxExemptionResult {
  checkoutId: string;
  metadataUpdated: boolean;
}

export async function executeTaxExemption(
  input: TaxExemptionInput,
  client: SaleorGraphqlClient,
): Promise<TaxExemptionOutput> {
  const { checkoutId, billingCountryCode, vatNumber, vatValidated } = input;

  const result = evaluateTaxExemption(billingCountryCode, vatValidated);

  logger.info("Tax exemption evaluated", {
    checkoutId,
    billingCountryCode,
    exempt: result.exempt,
    reason: result.reason,
  });

  // Call taxExemptionManage
  try {
    await client.setTaxExemption(checkoutId, result.exempt);
  } catch (error) {
    logger.error("Failed to set tax exemption", { checkoutId, error: String(error) });
    return { ...result, checkoutId, metadataUpdated: false };
  }

  // Update checkout metadata
  const metadata: Array<{ key: string; value: string }> = [
    { key: "b2b_tax_exempt_reason", value: result.reason },
  ];

  if (result.exempt && result.reason === "INTRA_EU_REVERSE_CHARGE") {
    metadata.push({ key: "b2b_reverse_charge", value: "true" });
  } else {
    metadata.push({ key: "b2b_reverse_charge", value: "false" });
  }

  if (vatNumber) {
    metadata.push({ key: "b2b_vat_number", value: vatNumber });
    metadata.push({ key: "b2b_vat_validated", value: String(vatValidated) });
    metadata.push({ key: "b2b_vat_country", value: billingCountryCode.toUpperCase() });
  }

  try {
    await client.updateCheckoutMetadata(checkoutId, metadata);
  } catch (error) {
    logger.error("Failed to update checkout metadata", { checkoutId, error: String(error) });
    return { ...result, checkoutId, metadataUpdated: false };
  }

  return { ...result, checkoutId, metadataUpdated: true };
}
