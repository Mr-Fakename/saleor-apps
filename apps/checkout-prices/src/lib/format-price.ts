export const formatPrice = (price: number | undefined | null) => {
  if (price === undefined || price === null) {
    return "No price available";
  }
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price);
};
