export interface TranslationKeys {
  // Index page
  index: {
    title: string;
    installPrompt: string;
    saleorUrl: string;
    addToSaleor: string;
  };

  // Pricing section
  pricing: {
    title: string;
    searchLabel: string;
    searchPlaceholder: string;
    foundVariants: string;
    foundVariant: string;
    loadingVariants: string;
    noVariantsSearch: string;
    noVariantsAvailable: string;
    firstPage: string;
    nextPage: string;
    // Table headers
    productVariant: string;
    basePrice: string;
    quantityPricingTiers: string;
    // Form controls
    remove: string;
    removeTier: string;
    addTier: string;
    addPricingTier: string;
    qty: string;
    price: string;
    quantity: string;
    minQty: string;
    unitPrice: string;
    // Save states
    save: string;
    saving: string;
    saved: string;
    savePricing: string;
  };

  // Storefront page
  storefront: {
    title: string;
    firstVariants: string;
    chooseVariant: string;
    pleaseChooseVariant: string;
    productDetails: string;
    hasQuantityPricing: string;
    noQuantityPricing: string;
    quantityLabel: string;
    priceWithQuantity: string;
    basePriceLabel: string;
    addAnotherItem: string;
    createCheckoutAndAdd: string;
    // Checkout
    checkout: string;
    checkoutId: string;
    lines: string;
    variant: string;
    quantityHeader: string;
    priceHeader: string;
    lineTotal: string;
    checkoutSubtotal: string;
  };

  // Order example
  order: {
    fetchingData: string;
    fetchingLastOrder: string;
    permissionInfo: string;
    lastOrder: string;
    containsLines: string;
    containsLine: string;
    noLines: string;
    totalAmount: string;
    shipsTo: string;
    seeOrderDetails: string;
    noOrdersFound: string;
  };

  // Common
  common: {
    loading: string;
    error: string;
  };
}

export const en: TranslationKeys = {
  // Index page
  index: {
    title: "Quantity based pricing and checkout app example",
    installPrompt: "Install this app in your Dashboard and get extra powers!",
    saleorUrl: "Saleor URL",
    addToSaleor: "Add to Saleor",
  },

  // Pricing section
  pricing: {
    title: "Quantity Based Pricing",
    searchLabel: "Search products/variants",
    searchPlaceholder: "Search by name, SKU...",
    foundVariants: "Found {count} variants",
    foundVariant: "Found 1 variant",
    loadingVariants: "Loading variants...",
    noVariantsSearch: "No variants found matching your search.",
    noVariantsAvailable: "No variants available.",
    firstPage: "First Page",
    nextPage: "Next Page",
    // Table headers
    productVariant: "Product / Variant",
    basePrice: "Base Price",
    quantityPricingTiers: "Quantity Pricing Tiers",
    // Form controls
    remove: "Remove",
    removeTier: "Remove Tier",
    addTier: "+ Add Tier",
    addPricingTier: "+ Add Pricing Tier",
    qty: "Qty",
    price: "Price",
    quantity: "Quantity",
    minQty: "Min qty",
    unitPrice: "Unit price",
    // Save states
    save: "Save",
    saving: "Saving...",
    saved: "Saved!",
    savePricing: "Save Pricing",
  },

  // Storefront page
  storefront: {
    title: "Custom pricing based on the metadata",
    firstVariants: "First variants from the shop:",
    chooseVariant: "Choose this variant",
    pleaseChooseVariant: "Please choose a variant",
    productDetails: "Product details",
    hasQuantityPricing: "The item has specified quantity based pricing:",
    noQuantityPricing: "The item has no quantity based pricing",
    quantityLabel: "Quantity:",
    priceWithQuantity: "Price (including quantity pricing):",
    basePriceLabel: "Base price:",
    addAnotherItem: "Add another item",
    createCheckoutAndAdd: "Create new checkout and add the item",
    // Checkout
    checkout: "Checkout",
    checkoutId: "ID:",
    lines: "Lines:",
    variant: "Variant",
    quantityHeader: "Quantity",
    priceHeader: "Price",
    lineTotal: "Line total",
    checkoutSubtotal: "Checkout subtotal:",
  },

  // Order example
  order: {
    fetchingData: "Fetching data",
    fetchingLastOrder: "Fetching the last order...",
    permissionInfo:
      "The orders query requires the MANAGE_ORDERS permission. If you want to query other resources, make sure to update the app permissions in the /src/pages/api/manifest.ts file.",
    lastOrder: "The last order #{number}:",
    containsLines: "Contains {count} lines",
    containsLine: "Contains 1 line",
    noLines: "Contains no lines",
    totalAmount: "For a total amount of {amount} {currency}",
    shipsTo: "Ships to {country}",
    seeOrderDetails: "See the order details",
    noOrdersFound: "No orders found",
  },

  // Common
  common: {
    loading: "Loading...",
    error: "Error",
  },
};
