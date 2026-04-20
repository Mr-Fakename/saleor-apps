import { err, ok, Result } from "neverthrow";
import { createLogger } from "../../logger";
import { ViesErrorCode, ViesResponse } from "./vies-types";

const logger = createLogger("ViesClient");

const VIES_WSDL_URL =
  "https://ec.europa.eu/taxation_customs/vies/services/checkVatService";
const VIES_TIMEOUT_MS = 20_000;
const VIES_MAX_RETRIES = 1;

function buildSoapEnvelope(countryCode: string, vatNumber: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:checkVat>
      <urn:countryCode>${countryCode}</urn:countryCode>
      <urn:vatNumber>${vatNumber}</urn:vatNumber>
    </urn:checkVat>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(
    `<(?:[^:]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[^:]+:)?${tag}>`,
    "i",
  );
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
}

function parseSoapResponse(
  xml: string,
): Result<ViesResponse, ViesErrorCode> {
  // Check for SOAP Fault
  if (xml.includes("Fault") || xml.includes("fault")) {
    const faultString = extractTag(xml, "faultstring");
    logger.warn("VIES SOAP fault", { faultString });
    return err("SOAP_FAULT");
  }

  const valid = extractTag(xml, "valid").toLowerCase() === "true";
  const name = extractTag(xml, "name");
  const address = extractTag(xml, "address");
  const countryCode = extractTag(xml, "countryCode");
  const vatNumber = extractTag(xml, "vatNumber");
  const requestDate = extractTag(xml, "requestDate");

  return ok({
    valid,
    countryCode,
    vatNumber,
    requestDate: requestDate || new Date().toISOString().split("T")[0],
    name: name === "---" ? "" : name,
    address: address === "---" ? "" : address,
  });
}

async function fetchVies(
  viesCountryCode: string,
  strippedVat: string,
): Promise<Result<ViesResponse, ViesErrorCode>> {
  const envelope = buildSoapEnvelope(viesCountryCode, strippedVat);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VIES_TIMEOUT_MS);

  try {
    const response = await fetch(VIES_WSDL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml;charset=UTF-8",
        SOAPAction: "",
      },
      body: envelope,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.error("VIES HTTP error", { status: response.status });
      return err("VIES_UNAVAILABLE");
    }

    const xml = await response.text();
    return parseSoapResponse(xml);
  } catch (error) {
    clearTimeout(timeout);

    if (
      error instanceof DOMException && error.name === "AbortError" ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      logger.warn("VIES request timed out");
      return err("VIES_TIMEOUT");
    }

    logger.error("VIES request failed", { error: String(error) });
    return err("VIES_UNAVAILABLE");
  }
}

export async function checkVat(
  countryCode: string,
  vatNumber: string,
): Promise<Result<ViesResponse, ViesErrorCode>> {
  // Strip country prefix from VAT number if present
  const strippedVat = vatNumber
    .toUpperCase()
    .startsWith(countryCode.toUpperCase())
    ? vatNumber.slice(countryCode.length)
    : vatNumber;

  // Greece: VIES expects EL, but country code is GR
  const viesCountryCode = countryCode === "GR" ? "EL" : countryCode;

  logger.info("Calling VIES", { countryCode: viesCountryCode });

  const result = await fetchVies(viesCountryCode, strippedVat);

  // Retry once on timeout — VIES is notoriously slow for some member states
  if (result.isErr() && result.error === "VIES_TIMEOUT" && VIES_MAX_RETRIES > 0) {
    logger.info("Retrying VIES after timeout", { countryCode: viesCountryCode });
    return fetchVies(viesCountryCode, strippedVat);
  }

  return result;
}

// Exported for testing
export const _internal = { buildSoapEnvelope, parseSoapResponse, extractTag };
