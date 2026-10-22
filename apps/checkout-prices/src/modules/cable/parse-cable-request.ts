import { isCheckoutId, isProductVariantId } from "../../lib/saleor-ids";
import { CABLE_MAX_QUANTITY, type CableLimits } from "./cable-config";

/**
 * Validates the /api/add-configured-cable body sent by the storefront server
 * action (storefront/packages/features/cable-configurator/src/actions.ts).
 *
 * Only IDENTIFIERS, the length and the quantity matter for pricing; they are
 * validated strictly. `totalPrice`/`currency` are the storefront's estimate and
 * are ignored — the app prices from Saleor. Display names are free text that
 * is only copied into line metadata, so they are type/length-checked. They are
 * NOT trusted: the dashboard resolves every component name live from its ID
 * (NR-35), and `directionCableName` is ignored — the handler writes Saleor's
 * name for the allow-listed `directionCableId`.
 */

const MAX_TEXT_LENGTH = 255;
const MAX_OPAQUE_ID_LENGTH = 128;

export interface CableConfigurationInput {
  connecteur1Id: string;
  connecteur2Id: string;
  connecteur3Id: string | null;
  typeCableId: string;
  referenceGaineId: string | null;
  directionCableId: string;
  /** centimetres */
  longueurCable: number;
  variantName: string;
  connecteur1Name: string;
  connecteur2Name: string;
  connecteur3Name: string | null;
  typeCableName: string;
  referenceGaineName: string | null;
  directionCableName: string;
  longueurCableName: string;
  configFingerprint: string | null;
}

export interface CableRequest {
  /** undefined = create a new checkout */
  checkoutId: string | undefined;
  baseVariantId: string;
  quantity: number;
  configuration: CableConfigurationInput;
}

export type ParseResult = { ok: true; value: CableRequest } | { ok: false; error: string };

class InvalidCableRequest extends Error {
  constructor(message: string) {
    super(message);
    // keep `instanceof` working whatever the compile target
    Object.setPrototypeOf(this, InvalidCableRequest.prototype);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isAbsent = (value: unknown) => value === undefined || value === null || value === "";

function requiredVariantId(source: Record<string, unknown>, field: string): string {
  const value = source[field];

  if (isAbsent(value)) {
    throw new InvalidCableRequest(`${field} has not been provided`);
  }
  if (!isProductVariantId(value)) {
    throw new InvalidCableRequest(`${field} is not a valid product variant ID`);
  }

  return value;
}

function optionalVariantId(source: Record<string, unknown>, field: string): string | null {
  return isAbsent(source[field]) ? null : requiredVariantId(source, field);
}

function requiredText(
  source: Record<string, unknown>,
  field: string,
  maxLength = MAX_TEXT_LENGTH,
  { allowEmpty = true }: { allowEmpty?: boolean } = {},
): string {
  const value = source[field];

  if (typeof value !== "string") {
    throw new InvalidCableRequest(`${field} must be a string`);
  }
  if (!allowEmpty && value.trim() === "") {
    throw new InvalidCableRequest(`${field} has not been provided`);
  }
  if (value.length > maxLength) {
    throw new InvalidCableRequest(`${field} is too long (max ${maxLength} characters)`);
  }

  return value;
}

function optionalText(source: Record<string, unknown>, field: string, maxLength = MAX_TEXT_LENGTH): string | null {
  return source[field] === undefined || source[field] === null ? null : requiredText(source, field, maxLength);
}

function parseQuantity(value: unknown): number {
  if (value === undefined || value === null) {
    return 1;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > CABLE_MAX_QUANTITY) {
    throw new InvalidCableRequest(`quantity must be an integer between 1 and ${CABLE_MAX_QUANTITY}`);
  }

  return value;
}

function parseLength(value: unknown, limits: CableLimits): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < limits.minLengthCm ||
    value > limits.maxLengthCm
  ) {
    throw new InvalidCableRequest(
      `longueurCable must be a length in centimetres between ${limits.minLengthCm} and ${limits.maxLengthCm}`,
    );
  }

  return value;
}

export function parseCableRequest(body: unknown, limits: CableLimits): ParseResult {
  try {
    if (!isRecord(body)) {
      throw new InvalidCableRequest("Request body must be a JSON object");
    }

    const baseVariantId = requiredVariantId(body, "baseVariantId");

    const configuration = body.configuration;

    if (!isRecord(configuration)) {
      throw new InvalidCableRequest("configuration has not been provided");
    }

    let checkoutId: string | undefined;

    if (!isAbsent(body.checkoutId)) {
      if (!isCheckoutId(body.checkoutId)) {
        throw new InvalidCableRequest("checkoutId is not a valid checkout ID");
      }
      checkoutId = body.checkoutId;
    }

    return {
      ok: true,
      value: {
        checkoutId,
        baseVariantId,
        quantity: parseQuantity(body.quantity),
        configuration: {
          connecteur1Id: requiredVariantId(configuration, "connecteur1Id"),
          connecteur2Id: requiredVariantId(configuration, "connecteur2Id"),
          connecteur3Id: optionalVariantId(configuration, "connecteur3Id"),
          typeCableId: requiredVariantId(configuration, "typeCableId"),
          referenceGaineId: optionalVariantId(configuration, "referenceGaineId"),
          directionCableId: requiredText(configuration, "directionCableId", MAX_OPAQUE_ID_LENGTH, {
            allowEmpty: false,
          }),
          longueurCable: parseLength(configuration.longueurCable, limits),
          variantName: requiredText(configuration, "variantName"),
          connecteur1Name: requiredText(configuration, "connecteur1Name"),
          connecteur2Name: requiredText(configuration, "connecteur2Name"),
          connecteur3Name: optionalText(configuration, "connecteur3Name"),
          typeCableName: requiredText(configuration, "typeCableName"),
          referenceGaineName: optionalText(configuration, "referenceGaineName"),
          directionCableName: requiredText(configuration, "directionCableName"),
          longueurCableName: requiredText(configuration, "longueurCableName"),
          configFingerprint: optionalText(configuration, "configFingerprint", MAX_OPAQUE_ID_LENGTH),
        },
      },
    };
  } catch (error) {
    if (error instanceof InvalidCableRequest) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
