export interface ViesResponse {
  valid: boolean;
  countryCode: string;
  vatNumber: string;
  requestDate: string;
  name: string;
  address: string;
}

export interface ViesValidationResult {
  valid: boolean | null;
  companyName: string | null;
  companyAddress: string | null;
  requestDate: string;
  cached: boolean;
  error: ViesErrorCode | null;
}

export type ViesErrorCode =
  | "VIES_UNAVAILABLE"
  | "VIES_TIMEOUT"
  | "VIES_INVALID_INPUT"
  | "SOAP_FAULT";
