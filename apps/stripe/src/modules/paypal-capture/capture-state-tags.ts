/**
 * A3d: the public metadata the capture worker writes on a Saleor transaction it holds for staff
 * (TransactionUpdateCaptureState, gate on only). Contract for the stuck-payment alert (ops) and
 * the storefront/Dashboard: keep these values in step with them.
 *
 *   stripe_capture_state        "held" (the only value the app writes)
 *   stripe_capture_hold_reason  one of CAPTURE_HOLD_REASONS (decide-capture.ts)
 *   stripe_capture_checked_at   ISO-8601 UTC time of the check that held it
 *
 * The worker never captures or tags a held transaction again (rule R5); it only releases it
 * when the order is CANCELED (OD1). Staff capture or cancel it in the Dashboard. The tag stays
 * after that: read it with the transaction's amounts.
 */
export const CAPTURE_STATE_METADATA_KEY = "stripe_capture_state" as const;
export const CAPTURE_HOLD_REASON_METADATA_KEY = "stripe_capture_hold_reason" as const;
export const CAPTURE_CHECKED_AT_METADATA_KEY = "stripe_capture_checked_at" as const;

export const CAPTURE_STATE_HELD = "held" as const;

export const buildCaptureHoldMetadata = (args: { reason: string; checkedAt: Date }) => [
  { key: CAPTURE_STATE_METADATA_KEY, value: CAPTURE_STATE_HELD },
  { key: CAPTURE_HOLD_REASON_METADATA_KEY, value: args.reason },
  { key: CAPTURE_CHECKED_AT_METADATA_KEY, value: args.checkedAt.toISOString() },
];
