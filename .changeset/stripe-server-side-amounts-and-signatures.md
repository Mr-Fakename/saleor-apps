---
"saleor-app-payment-stripe": patch
---

Refund requests must now carry a valid Saleor signature. Before: `TRANSACTION_REFUND_REQUESTED`
skipped signature verification, so anyone who knew a PaymentIntent id could make the app refund
it in Stripe. After: all six Saleor webhooks use the SDK's default verification (JWKS refreshed
once on failure). A forged or invalid signature gets a 401 and no Stripe call is made. If a real
refund is rejected, the Dashboard shows the refund as failed and no money moves.

`/api/update-payment-intent` no longer takes the amount from the request. Before: any caller
could set a PaymentIntent to any amount, for example to pay less. After: the app reads the
checkout from Saleor and writes its total to Stripe, minus money that other transactions of the
checkout already hold. It refuses a PaymentIntent that does not belong to that checkout, a
currency mismatch, a PaymentIntent that can no longer change, and a checkout with another
payment still pending. Browser requests from an origin that is not in
`UPDATE_PAYMENT_INTENT_ALLOWED_ORIGINS` get a 403 (unset = none). The storefront proxies call
the route server-to-server and need no change.

The `debug-apl` and `debug-auth` routes are removed. They listed the installed Saleor
instances.
