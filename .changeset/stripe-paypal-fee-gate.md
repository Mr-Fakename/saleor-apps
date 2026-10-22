---
"saleor-app-payment-stripe": minor
---

The Stripe app can now enforce the PayPal service fee itself (PayPal-fee hard gate, A3c). It is
off unless `PAYMENT_FEE_GATE=paypal` is set. With the variable unset, nothing changes: the
PaymentIntents, the Saleor queries and mutations, and the responses are exactly as before.

With the gate on (`PAYMENT_FEE_GATE=paypal`, `PAYMENT_FEE_RATE_PERCENT`, `PAYMENT_FEE_VARIANT_ID`,
optional `PAYMENT_FEE_METADATA_KEY`, all equal to the checkout-prices app's values; the app does
not start if the rate or the variant is missing or invalid):

- `paymentGatewayInitialize` adds `paymentFeeGate: { method: "paypal", ratePercent }` next to
  `stripePublishableKey`, so the storefront can show PayPal as a separate choice.
- `transactionInitialize` reads the choice from `data.paymentIntent.paymentMethod`. Before: every
  PaymentIntent offered every method, PayPal included, whatever the checkout's fee line. After:
  PayPal with a correct fee line gets a PayPal-only PaymentIntent (`payment_method_types:
  ["paypal"]`); any other choice without a fee line gets a PaymentIntent that offers every method
  except PayPal (`excluded_payment_method_types: ["paypal"]`). The fee line is checked with the
  checkout-prices rule on the same checkout read as the amount. A PayPal choice without a correct
  fee line, or another choice with a fee line, is refused with the code
  `PaymentMethodNotAllowedError` before any Stripe call. A PayPal choice on an order is refused.
  The PaymentIntent records its policy in the metadata `saleor_payment_policy` (`paypal-only` or
  `no-paypal`), and the Saleor transaction gets the metadata `stripe_payment_policy`.
- A PaymentIntent is reused or updated only when it already has the policy needed. When the
  shopper switches between PayPal and the other methods, the app cancels the old PaymentIntent and
  creates a new one, because Stripe cannot change the methods of a PaymentIntent.
- `/api/update-payment-intent` refuses with HTTP 409 and a `code` when the PaymentIntent's policy
  and the checkout's fee line disagree: `PAYMENT_FEE_REQUIRED`, `PAYMENT_FEE_STALE`,
  `PAYMENT_FEE_PRESENT`, or `PAYMENT_POLICY_REINIT` for a PaymentIntent created before the gate.
  The amount is not changed in these cases.
