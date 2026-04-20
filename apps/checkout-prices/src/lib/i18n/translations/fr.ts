import { TranslationKeys } from "./en";

export const fr: TranslationKeys = {
  // Index page
  index: {
    title: "Exemple d'application de tarification par quantité et de paiement",
    installPrompt: "Installez cette application dans votre tableau de bord et obtenez des fonctionnalités supplémentaires !",
    saleorUrl: "URL Saleor",
    addToSaleor: "Ajouter à Saleor",
  },

  // Pricing section
  pricing: {
    title: "Tarification par quantité",
    searchLabel: "Rechercher produits/variantes",
    searchPlaceholder: "Rechercher par nom, SKU...",
    foundVariants: "{count} variantes trouvées",
    foundVariant: "1 variante trouvée",
    loadingVariants: "Chargement des variantes...",
    noVariantsSearch: "Aucune variante trouvée correspondant à votre recherche.",
    noVariantsAvailable: "Aucune variante disponible.",
    firstPage: "Première page",
    nextPage: "Page suivante",
    // Table headers
    productVariant: "Produit / Variante",
    basePrice: "Prix de base",
    quantityPricingTiers: "Paliers de tarification",
    // Form controls
    remove: "Supprimer",
    removeTier: "Supprimer le palier",
    addTier: "+ Ajouter un palier",
    addPricingTier: "+ Ajouter un palier de tarification",
    qty: "Qté",
    price: "Prix",
    quantity: "Quantité",
    minQty: "Qté min",
    unitPrice: "Prix unitaire",
    // Save states
    save: "Enregistrer",
    saving: "Enregistrement...",
    saved: "Enregistré !",
    savePricing: "Enregistrer les prix",
  },

  // Storefront page
  storefront: {
    title: "Tarification personnalisée basée sur les métadonnées",
    firstVariants: "Premières variantes de la boutique :",
    chooseVariant: "Choisir cette variante",
    pleaseChooseVariant: "Veuillez choisir une variante",
    productDetails: "Détails du produit",
    hasQuantityPricing: "Cet article a une tarification par quantité spécifiée :",
    noQuantityPricing: "Cet article n'a pas de tarification par quantité",
    quantityLabel: "Quantité :",
    priceWithQuantity: "Prix (incluant la tarification par quantité) :",
    basePriceLabel: "Prix de base :",
    addAnotherItem: "Ajouter un autre article",
    createCheckoutAndAdd: "Créer un nouveau panier et ajouter l'article",
    // Checkout
    checkout: "Panier",
    checkoutId: "ID :",
    lines: "Lignes :",
    variant: "Variante",
    quantityHeader: "Quantité",
    priceHeader: "Prix",
    lineTotal: "Total ligne",
    checkoutSubtotal: "Sous-total du panier :",
  },

  // Order example
  order: {
    fetchingData: "Récupération des données",
    fetchingLastOrder: "Récupération de la dernière commande...",
    permissionInfo:
      "La requête orders nécessite la permission MANAGE_ORDERS. Si vous souhaitez interroger d'autres ressources, assurez-vous de mettre à jour les permissions de l'application dans le fichier /src/pages/api/manifest.ts.",
    lastOrder: "La dernière commande n°{number} :",
    containsLines: "Contient {count} lignes",
    containsLine: "Contient 1 ligne",
    noLines: "Ne contient aucune ligne",
    totalAmount: "Pour un montant total de {amount} {currency}",
    shipsTo: "Livraison vers {country}",
    seeOrderDetails: "Voir les détails de la commande",
    noOrdersFound: "Aucune commande trouvée",
  },

  // Common
  common: {
    loading: "Chargement...",
    error: "Erreur",
  },
};
