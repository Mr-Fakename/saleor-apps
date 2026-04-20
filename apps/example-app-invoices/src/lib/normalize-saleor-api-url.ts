/**
 * Normalizes Saleor API URL to use HTTPS protocol
 * This fixes webhook issues where URLs come through as HTTP but need to be HTTPS
 * for proper authentication with the APL (Auth Persistence Layer)
 */
export function normalizeSaleorApiUrl(saleorApiUrl: string): string {
  if (saleorApiUrl.startsWith('http://')) {
    return saleorApiUrl.replace('http://', 'https://');
  }
  return saleorApiUrl;
}