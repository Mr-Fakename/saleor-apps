import { TranslationKeys } from "./en";

export const fr: TranslationKeys = {
  // Dashboard
  dashboard: {
    title: "Tableau de bord des extensions client",
  },

  // Tabs
  tabs: {
    reviewModeration: "Modération des avis",
    orderUnlocks: "Déblocage des commandes",
  },

  // Review Moderation
  reviews: {
    title: "Modération des avis",
    totalReviews: "Total des avis",
    filterByStatus: "Filtrer par statut",
    noReviewsFound: "Aucun avis trouvé",
    // Table headers
    date: "Date",
    user: "Utilisateur",
    product: "Produit",
    rating: "Note",
    comment: "Commentaire",
    status: "Statut",
    actions: "Actions",
    // Status labels
    statusPending: "En attente",
    statusApproved: "Approuvé",
    statusDeleted: "Supprimé",
    // Actions
    pass: "Approuver",
    delete: "Supprimer",
    permanentlyDelete: "Supprimer définitivement",
    // Help text
    helpText:
      "Cliquez sur les en-têtes de colonnes pour trier. Utilisez \"Approuver\" pour valider un avis ou \"Supprimer\" pour le marquer comme supprimé (suppression douce). Les avis supprimés sont conservés pour le suivi des mauvais utilisateurs. Utilisez \"Supprimer définitivement\" pour retirer complètement un avis.",
    // Errors
    errorLoading: "Erreur lors du chargement des avis",
    failedToApprove: "Échec de l'approbation de l'avis. Veuillez réessayer.",
  },

  // Order Unlocks
  orders: {
    title: "Déblocage des commandes",
    description:
      "Débloquez les commandes pour permettre aux clients de soumettre des avis. Les clients ne peuvent pas évaluer les produits tant que leur commande n'est pas débloquée.",
    searchPlaceholder: "Rechercher par numéro de commande...",
    recentOrders: "Commandes récentes",
    searchResults: "Résultats de recherche",
    unlockedOrders: "Commandes débloquées",
    noOrdersFound: "Aucune commande trouvée",
    noUnlockedOrders: "Aucune commande n'a encore été débloquée",
    loadingOrders: "Chargement des commandes...",
    loadingUnlockedOrders: "Chargement des commandes débloquées...",
    errorLoadingOrders: "Erreur lors du chargement des commandes",
    errorLoadingUnlockedOrders: "Erreur lors du chargement des commandes débloquées",
    // Table headers
    orderNumber: "N° de commande",
    customerEmail: "Email du client",
    customer: "Client",
    orderStatus: "Statut",
    unlockStatus: "Statut de déblocage",
    unlockedAt: "Débloqué le",
    unlockedBy: "Débloqué par",
    action: "Action",
    // Status
    locked: "Verrouillé",
    unlocked: "Débloqué",
    // Actions
    unlock: "Débloquer",
    lock: "Verrouiller",
    // Errors
    failedToUnlock: "Échec du déblocage de la commande. Veuillez réessayer.",
    failedToLock: "Échec du verrouillage de la commande. Veuillez réessayer.",
  },

  // Common
  common: {
    loading: "Chargement...",
    error: "Erreur",
  },
};
