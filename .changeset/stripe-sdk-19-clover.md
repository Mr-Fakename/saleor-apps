---
"saleor-app-payment-stripe": patch
---

The Stripe library moves from stripe-node 18.1.0 to 19.3.0. Before: the app called Stripe with
API version `2025-04-30.basil`. After: it calls Stripe with `2025-10-29.clover`, the version that
stripe-node 19.3.0 uses. There is no change in behaviour: payments, captures, cancellations,
refunds and webhook signature checks work as before. The fields the app reads did not change in
the new API version, and the library's retry, timeout and webhook signature code is the same.

Stripe webhook endpoints keep the API version they were created with. The endpoints that exist
now stay on `2025-04-30.basil`, and the app reads their events as before. Only an endpoint that
the app creates for a new Stripe configuration gets `2025-10-29.clover`.
