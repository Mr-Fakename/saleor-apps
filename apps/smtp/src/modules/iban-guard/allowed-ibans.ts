/**
 * The only bank accounts outgoing mail may show a customer.
 *
 * Each entry is the SHA-256 of the IBAN normalized by `normalizeIban` (no spaces,
 * uppercase). Pinned in code on purpose, not in env: an attacker who reaches the
 * Dokploy settings, a staff Dashboard session or a leaked /api/send key must still not
 * be able to put their own IBAN in front of our customers. Changing the shop's bank
 * account therefore takes a reviewed commit and an image rebuild.
 *
 * To add an account:
 *   printf '%s' 'FR7630006000011234567890189' | sha256sum
 * and keep the storefront's PINNED_IBAN_SHA256 (saleor-storefront
 * src/lib/bank-transfer.ts) in step, or bank-transfer emails stop going out.
 */
export const ALLOWED_IBANS: ReadonlyArray<{ sha256: string; label: string }> = [
  {
    sha256: "1fdce66b8eb7c3570045f14490e9f1f2b43739fe8ecdf5fab65d863ee1029dd5",
    label: "Dess Equipement — shop account (FR76…6448)",
  },
];
