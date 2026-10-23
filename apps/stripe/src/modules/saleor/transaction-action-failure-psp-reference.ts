import { randomUUID } from "crypto";

/**
 * pspReferences for the CHARGE_FAILURE and CANCEL_FAILURE the app answers itself (a refusal, or a
 * definite Stripe error). Same pattern as the refund failures (createRefundFailurePspReference,
 * A2e). They never repeat and are never a PaymentIntent id, so they match no other event.
 *
 * Why, in Saleor 3.22.74:
 * - Saleor copies the answer's pspReference onto the CHARGE_REQUEST / CANCEL_REQUEST and saves
 *   the answer as an event that counts in the amounts (payment/utils.py
 *   create_transaction_event_from_request_and_webhook_response, _create_event_from_response:
 *   include_in_calculations=True).
 * - It groups the events of a transaction by pspReference, and for one pspReference it counts
 *   the CHARGE_SUCCESS (or CANCEL_SUCCESS) only when no newer FAILURE exists
 *   (payment/transaction_item_calculations.py _should_increse_amount, used by
 *   _recalculate_charge_amounts and _recalculate_cancel_amounts).
 * So a failure under the PaymentIntent id, answered to a second capture of a captured
 * PaymentIntent, took chargedAmount back to 0. Under its own pspReference the failure is grouped
 * with its own request only and moves no amount.
 */
export const createChargeFailurePspReference = (): string => `charge-failure-${randomUUID()}`;

/** See createChargeFailurePspReference. */
export const createCancelFailurePspReference = (): string => `cancel-failure-${randomUUID()}`;
