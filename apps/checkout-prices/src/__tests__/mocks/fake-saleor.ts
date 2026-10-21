import type { DocumentNode } from "graphql";

/**
 * In-memory stand-in for the Saleor GraphQL API, used at the urql-client
 * boundary (`createClient` from src/lib/create-graphql-client is mocked to
 * return `fakeSaleor.client`). Operations are dispatched by operation NAME,
 * so the fake serves both the generated documents and the app's inline ones.
 * Unknown operations throw, so a test never silently passes on a query the
 * fake does not understand.
 */

type Metadata = Array<{ key: string; value: string }>;

export interface FakeLine {
  id: string;
  variantId: string;
  quantity: number;
  unitPrice: number;
  metadata: Metadata;
}

export interface FakeCheckout {
  id: string;
  channelSlug: string;
  currency: string;
  shipping: number;
  lines: FakeLine[];
}

export interface FakeVariant {
  id: string;
  name: string;
  productName: string;
  productSlug: string;
  /** null = no price in the channel (Saleor returns pricing: null) */
  price: number | null;
  currency: string;
  attributes: Array<{ slug: string; references: string[] }>;
}

export interface FakeProduct {
  id: string;
  defaultVariantId: string | null;
}

type Vars = Record<string, unknown>;
type OperationResult = { data?: unknown; error?: { message: string } };

export function toGlobalId(type: string, id: string | number): string {
  return Buffer.from(`${type}:${id}`).toString("base64");
}

let uuidCounter = 0;

export function fakeUuid(): string {
  uuidCounter += 1;

  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

function operationName(doc: DocumentNode): string {
  for (const def of doc.definitions) {
    if (def.kind === "OperationDefinition" && def.name) {
      return def.name.value;
    }
  }
  throw new Error("FakeSaleor: document has no named operation");
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const money = (amount: number, currency: string) => ({ gross: { amount: round2(amount), currency } });

// Saleor's PositiveDecimal: a decimal string/number >= 0.
function parsePositiveDecimal(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;

  return Number.isFinite(n) && n >= 0 ? n : null;
}

export class FakeSaleor {
  checkouts = new Map<string, FakeCheckout>();
  variants = new Map<string, FakeVariant>();
  products = new Map<string, FakeProduct>();
  /** every executed operation, in order */
  calls: Array<{ name: string; variables: Vars }> = [];
  /** test hook: runs before checkoutLinesAdd applies its lines */
  beforeLinesAdd: ((checkout: FakeCheckout) => void) | null = null;
  private lineCounter = 0;

  readonly client = {
    query: (doc: DocumentNode, variables: Vars) => ({
      toPromise: () => Promise.resolve(this.execute(doc, variables)),
    }),
    mutation: (doc: DocumentNode, variables: Vars) => ({
      toPromise: () => Promise.resolve(this.execute(doc, variables)),
    }),
  };

  reset() {
    this.checkouts.clear();
    this.variants.clear();
    this.products.clear();
    this.calls = [];
    this.beforeLinesAdd = null;
  }

  addVariant(variant: FakeVariant) {
    this.variants.set(variant.id, variant);
  }

  addProduct(product: FakeProduct) {
    this.products.set(product.id, product);
  }

  addCheckout(partial: Partial<FakeCheckout> & { id?: string }): FakeCheckout {
    const checkout: FakeCheckout = {
      id: partial.id ?? toGlobalId("Checkout", fakeUuid()),
      channelSlug: partial.channelSlug ?? "default-channel",
      currency: partial.currency ?? "EUR",
      shipping: partial.shipping ?? 0,
      lines: partial.lines ?? [],
    };

    this.checkouts.set(checkout.id, checkout);

    return checkout;
  }

  newLine(variantId: string, quantity: number, unitPrice: number, metadata: Metadata = []): FakeLine {
    this.lineCounter += 1;

    return {
      id: toGlobalId("CheckoutLine", `line-${this.lineCounter}`),
      variantId,
      quantity,
      unitPrice,
      metadata,
    };
  }

  mutationNames(): string[] {
    const mutations = new Set(["AddLinesToCheckout", "CheckoutLinesDelete", "CreateExampleCheckout", "CheckoutLinesUpdate"]);

    return this.calls.map((c) => c.name).filter((name) => mutations.has(name));
  }

  execute(doc: DocumentNode, variables: Vars): OperationResult {
    const name = operationName(doc);

    this.calls.push({ name, variables });

    switch (name) {
      case "GetCheckoutDetails": {
        const checkout = this.checkouts.get(String(variables.id));

        return { data: { checkout: checkout ? this.checkoutDetails(checkout) : null } };
      }
      case "PaymentFeeCheckout": {
        const checkout = this.checkouts.get(String(variables.id));

        return {
          data: {
            checkout: checkout
              ? {
                  id: checkout.id,
                  totalPrice: money(this.total(checkout), checkout.currency),
                  lines: checkout.lines.map((line) => ({
                    id: line.id,
                    quantity: line.quantity,
                    metadata: line.metadata,
                    totalPrice: money(line.unitPrice * line.quantity, checkout.currency),
                  })),
                }
              : null,
          },
        };
      }
      case "CableCheckoutChannel": {
        const checkout = this.checkouts.get(String(variables.id));

        return {
          data: { checkout: checkout ? { id: checkout.id, channel: { slug: checkout.channelSlug } } : null },
        };
      }
      case "GetVariantDetails": {
        const variant = this.variants.get(String(variables.id));

        return { data: { productVariant: variant ? this.variantDetails(variant) : null } };
      }
      case "CableBaseVariant": {
        const variant = this.variants.get(String(variables.id));

        return {
          data: {
            productVariant: variant
              ? {
                  id: variant.id,
                  product: { slug: variant.productSlug },
                  pricing:
                    variant.price === null ? null : { price: money(variant.price, variant.currency) },
                  attributes: variant.attributes.map((attr) => ({
                    attribute: { slug: attr.slug },
                    values: attr.references.map((reference) => ({ reference })),
                  })),
                }
              : null,
          },
        };
      }
      case "CableOptionProducts": {
        const ids = Array.isArray(variables.ids) ? variables.ids.map(String) : [];
        const edges = ids
          .map((id) => this.products.get(id))
          .filter((p): p is FakeProduct => !!p)
          .map((p) => ({ node: { id: p.id, defaultVariant: p.defaultVariantId ? { id: p.defaultVariantId } : null } }));

        return { data: { products: { edges } } };
      }
      case "CheckoutLinesDelete": {
        const checkout = this.checkouts.get(String(variables.checkoutId));
        const lineIds = Array.isArray(variables.lineIds) ? variables.lineIds.map(String) : [];

        if (!checkout) {
          return { data: { checkoutLinesDelete: { checkout: null, errors: [{ field: "id", message: "not found", code: "NOT_FOUND" }] } } };
        }
        const missing = lineIds.filter((id) => !checkout.lines.some((l) => l.id === id));

        if (missing.length > 0) {
          return {
            data: {
              checkoutLinesDelete: {
                checkout: null,
                errors: [{ field: "lineId", message: "Couldn't resolve to a node", code: "GRAPHQL_ERROR" }],
              },
            },
          };
        }
        checkout.lines = checkout.lines.filter((l) => !lineIds.includes(l.id));

        return { data: { checkoutLinesDelete: { checkout: this.checkoutDetails(checkout), errors: [] } } };
      }
      case "AddLinesToCheckout": {
        const checkout = this.checkouts.get(String(variables.id));

        if (!checkout) {
          return { data: { checkoutLinesAdd: { checkout: null, errors: [{ field: "id", message: "not found", code: "NOT_FOUND" }] } } };
        }
        const added = this.buildLines(variables.lines);

        if ("error" in added) {
          return { error: { message: added.error } };
        }
        this.beforeLinesAdd?.(checkout);
        checkout.lines.push(...added.lines);

        return { data: { checkoutLinesAdd: { checkout: this.checkoutDetails(checkout), errors: [] } } };
      }
      case "CreateExampleCheckout": {
        const input = (variables.input ?? {}) as Vars;
        const added = this.buildLines(input.lines);

        if ("error" in added) {
          return { error: { message: added.error } };
        }
        const checkout = this.addCheckout({ channelSlug: String(input.channel), lines: added.lines });

        return { data: { checkoutCreate: { checkout: this.checkoutDetails(checkout) } } };
      }
      default:
        throw new Error(`FakeSaleor: unexpected operation ${name}`);
    }
  }

  linesWithMetadataKey(checkoutId: string, key: string): FakeLine[] {
    const checkout = this.checkouts.get(checkoutId);

    return checkout ? checkout.lines.filter((l) => l.metadata.some((m) => m.key === key)) : [];
  }

  total(checkout: FakeCheckout): number {
    return round2(checkout.lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0) + checkout.shipping);
  }

  private buildLines(rawLines: unknown): { lines: FakeLine[] } | { error: string } {
    const lines: FakeLine[] = [];

    for (const raw of Array.isArray(rawLines) ? rawLines : []) {
      const input = raw as Vars;
      const variant = this.variants.get(String(input.variantId));

      if (!variant) {
        return { error: `Couldn't resolve variant ${String(input.variantId)}` };
      }
      let unitPrice = variant.price ?? 0;

      if (input.price !== undefined) {
        const parsed = parsePositiveDecimal(input.price);

        if (parsed === null) {
          return { error: `Expected PositiveDecimal, got ${String(input.price)}` };
        }
        unitPrice = parsed;
      }
      lines.push(this.newLine(variant.id, Number(input.quantity), unitPrice, (input.metadata as Metadata) ?? []));
    }

    return { lines };
  }

  private variantDetails(variant: FakeVariant) {
    return {
      id: variant.id,
      name: variant.name,
      product: { name: variant.productName },
      pricing:
        variant.price === null
          ? null
          : {
              onSale: false,
              discount: null,
              price: money(variant.price, variant.currency),
              priceUndiscounted: money(variant.price, variant.currency),
            },
      quantityPricing: null,
    };
  }

  private checkoutDetails(checkout: FakeCheckout) {
    return {
      id: checkout.id,
      token: Buffer.from(checkout.id, "base64").toString("utf8").split(":")[1],
      lines: checkout.lines.map((line) => {
        const variant = this.variants.get(line.variantId);

        return {
          id: line.id,
          variant: variant ? this.variantDetails(variant) : null,
          quantity: line.quantity,
          metadata: line.metadata,
          unitPrice: money(line.unitPrice, checkout.currency),
          totalPrice: money(line.unitPrice * line.quantity, checkout.currency),
        };
      }),
      subtotalPrice: money(
        checkout.lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0),
        checkout.currency,
      ),
    };
  }
}

export const fakeSaleor = new FakeSaleor();
