---
"saleor-app-payment-stripe": minor
---

PayPal payments can now be authorized first and captured only after the app checked the order
(A3d, part of the PayPal-fee gate). Nothing changes unless `PAYMENT_FEE_GATE=paypal` is set:
shops without the gate keep exactly today's PaymentIntents, Saleor documents and answers.

Before: with the gate on, a PayPal-only PaymentIntent was captured by Stripe at approval. A shopper
who swapped the PayPal fee line for an item of the same price before approving paid without the
fee.

After, with the gate on and `PAYMENT_FEE_PAYPAL_CAPTURE=manual` (the default; `automatic` is the
kill switch, any other value stops the app at boot):

- PayPal-only PaymentIntents are created with `payment_method_options.paypal.capture_method:
  "manual"`, so approval only authorizes them. Card and the other methods are unchanged. An older
  PayPal-only PaymentIntent without manual capture is never reused (`transactionInitialize`
  replaces it; `/api/update-payment-intent` answers `PAYMENT_POLICY_REINIT`).
- A capture worker runs inside the app (started at server start, first sweep after 30 s, then
  every 60 s, plus checks 15, 45 and 120 s after each PayPal authorization). It captures only when
  the Saleor transaction sits on an order that passes every check (order status, the Saleor
  ledger, one payment, currency, the PayPal fee line on the ORDER lines, order total equal to the
  authorization). It captures by asking Saleor (`transactionRequestAction`, CHARGE of the order
  total), which calls the app's existing capture handler. It never captures less.
- Anything that does not pass is held for staff: the Saleor transaction gets the public metadata
  `stripe_capture_state=held`, `stripe_capture_hold_reason` and `stripe_capture_checked_at`, and an
  error is logged. Staff capture or cancel it in the Dashboard.
- The authorization of an order canceled before capture is released (CANCEL through Saleor).
- A capture or release request that has no effect at Stripe (Saleor re-sends such requests with an
  empty body) is checked again after 90 s and repeated, at most 3 times, then held
  (`capture-stuck` / `release-stuck`).
- An authorization that Saleor has still not recorded 30 minutes after the first check (for
  example, a lost Stripe webhook) is held as well (`authorization-not-recorded`), instead of
  waiting until it expires.
- Every Saleor call of the worker times out after 15 seconds. A capture request that times out is
  treated as "maybe sent": it is never repeated before the PaymentIntent is read again.
- One sweeper at a time (DynamoDB lease) and one check per PaymentIntent at a time (DynamoDB
  claim), in the app's existing table.
