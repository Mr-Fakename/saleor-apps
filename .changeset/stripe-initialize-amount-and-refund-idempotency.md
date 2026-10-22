---
"saleor-app-payment-stripe": patch
---

A payment started with `transactionInitialize` now charges what the checkout owes, not the
amount the caller sends. Before: the PaymentIntent took `transactionInitialize(amount:)` as is,
so a shopper could pay 0.50 € for a full order, or be charged the full total again on top of a
payment already made. After: the app reads the checkout from Saleor and charges its total
(already net of vouchers and gift cards) minus money that the checkout's transactions already
hold, and tells Saleor that amount. It refuses to start a payment when another payment of the
checkout is still pending, when nothing is left to pay, and on a currency mismatch. In the first
two cases it first cancels the checkout's other PaymentIntents that can still be paid. A
PaymentIntent named by the storefront (`existingPaymentIntentId`) is used only if the app
created it for that checkout; a PaymentIntent of another checkout or order is never changed.
Payments started on an order (no storefront does this) keep the requested amount and are logged.

The app no longer leaves a second payable PaymentIntent next to the one it hands out. Before:
only one of its three paths (storefront PaymentIntent, PaymentIntent found for the checkout,
new PaymentIntent) cancelled the checkout's other PaymentIntents, and a failed Stripe search
created a new one without any check, so a shopper with two tabs open could pay twice. After:
on every path, the checkout's other PaymentIntents that can still be paid are cancelled first.
They are found on the checkout's Saleor transactions and through the Stripe search; one that
Saleor already recorded as cancelled is not checked again, and at most five are checked at a
time. A PaymentIntent found through the Stripe search is read again from Stripe before it is
reused, because the search can be up to a minute out of date: one whose amount changed is
updated, one that was cancelled is replaced, and one that is being paid stops the request. The
app refuses to start a payment while another PaymentIntent of the checkout is processing or
paid and Saleor has not recorded it yet (it then also cancels the one it would have handed
out), and when another PaymentIntent can be neither read nor cancelled. When the Stripe search
fails, a checkout payment goes on with the PaymentIntents listed on the checkout's Saleor
transactions (the failure is logged as an error); a payment started on an order is still
refused. A PaymentIntent whose payment Saleor recorded is never cancelled, so a recorded
authorization is not voided.

A checkout whose earlier payment was fully refunded or charged back can be paid again. Before:
every new payment attempt on it was refused as "already being processed".

Refunds are idempotent in Stripe. Before: if Stripe created a refund but Saleor did not get
the answer in time, a retry (Saleor's automatic re-send, or staff clicking refund again)
created a second refund. After: a retry of the same refund request gets the refund Stripe
already created. A refund made from a Saleor granted refund is keyed on that granted refund
only, so two granted refunds of the same amount on one payment are two refunds in Stripe. If
staff change the amount of a failed granted refund and retry it, the app refuses it with "amount
changed after a possibly-successful attempt; create a new granted refund" instead of refunding
again, because the failed attempt may have refunded the customer. This needs the app's
TRANSACTION_REFUND_REQUESTED webhook to be updated in each Saleor (`pnpm migrate`, or
`webhookUpdate` with the new subscription query, which adds `grantedRefund { id }` and the
transaction's `events`). Until then, and for a refund requested without a granted refund, a
second refund of exactly the same amount on the same payment within 24 hours returns the first
refund instead of creating a new one. Once the webhook is updated, the app answers such a
request with "identical refund within 24 h; use a granted refund" when Saleor already recorded
the first refund, instead of reporting a refund that moved no money; before the update it only
logs it. The app sends these two refusals to Saleor without a PSP reference, so Saleor records
a failed refund that never hides an earlier refund of the same payment from the refunded amount.
When the transaction already holds a failed refund without a PSP reference (for example a
timed-out attempt), Saleor can show its own message, or that earlier failure's, instead of the
app's. A refund retried after the checkout became an order no longer fails with a Stripe
idempotency error: refunds now carry only the Saleor transaction ID in their Stripe metadata,
not the checkout or order ID.
