import { TransactionEventTypeEnum } from "@/generated/graphql";

import { CheckoutPaymentStateTransaction } from "./checkout-payment-state-fetcher";

/**
 * Event types that exist only after money moved: Saleor writes them when a PSP reports an
 * authorization, a charge, a chargeback, a refund (or its reversal) or a cancel. Requests,
 * failures, "action required" and INFO events move no money.
 */
const MONEY_MOVEMENT_EVENT_TYPES: ReadonlySet<TransactionEventTypeEnum> =
  new Set<TransactionEventTypeEnum>([
    "AUTHORIZATION_SUCCESS",
    "AUTHORIZATION_ADJUSTMENT",
    "CHARGE_SUCCESS",
    "CHARGE_BACK",
    "REFUND_SUCCESS",
    "REFUND_REVERSE",
    "CANCEL_SUCCESS",
  ]);

/**
 * True when Saleor has recorded money moving on the transaction at any time, including money
 * that went back since (review M2). The amounts alone are not enough: after a full refund
 * `chargedAmount` is 0 (the money is in `refundedAmount`), and a CHARGE_BACK lowers
 * `chargedAmount` without any amount field of its own (saleor/payment/
 * transaction_item_calculations.py), so a fully charged-back transaction has every amount
 * at 0 and only its events show the payment.
 */
export const hasRecordedMoneyMovement = (transaction: CheckoutPaymentStateTransaction): boolean =>
  [
    transaction.chargedAmount,
    transaction.authorizedAmount,
    transaction.chargePendingAmount,
    transaction.authorizePendingAmount,
    transaction.refundedAmount,
    transaction.refundPendingAmount,
    transaction.canceledAmount,
    transaction.cancelPendingAmount,
  ].some((money) => money.amount > 0) ||
  transaction.events.some((event) => !!event.type && MONEY_MOVEMENT_EVENT_TYPES.has(event.type));
