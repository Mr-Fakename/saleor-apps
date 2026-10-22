import { z } from "zod";

const saleorGrantedRefundIdSchema = z.string().min(1).brand("SaleorGrantedRefundId");

export type SaleorGrantedRefundId = z.infer<typeof saleorGrantedRefundIdSchema>;

/**
 * base64("OrderGrantedRefund:None"). Saleor's `TransactionRefundRequested.grantedRefund`
 * resolver wraps the granted refund in a context object even when there is none, and a
 * GlobalID resolver on a missing node returns this id instead of null. Not observed on a
 * live Saleor yet: read as "no granted refund", it can only make the key fall back to v1.
 */
const MISSING_GRANTED_REFUND_GLOBAL_ID = "T3JkZXJHcmFudGVkUmVmdW5kOk5vbmU=";

/**
 * The granted refund of a TRANSACTION_REFUND_REQUESTED payload, or null when there is none:
 * field absent (a Saleor still on the subscription registered before review M3), null (a
 * refund requested without a granted refund, e.g. `transactionRequestAction(REFUND)`), or
 * the id of a missing node.
 */
export const saleorGrantedRefundIdFromPayload = (
  grantedRefund: { readonly id: string } | null | undefined,
): SaleorGrantedRefundId | null => {
  const parsed = saleorGrantedRefundIdSchema.safeParse(grantedRefund?.id);

  if (!parsed.success || parsed.data === MISSING_GRANTED_REFUND_GLOBAL_ID) {
    return null;
  }

  return parsed.data;
};
