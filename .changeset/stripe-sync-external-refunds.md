---
"saleor-app-payment-stripe": patch
---

Refunds issued from the Stripe Dashboard now show up in Saleor. Before: only refunds started
from Saleor were reported back — the app subscribed to `charge.refund.updated` alone (which does
not fire for a dashboard refund that succeeds immediately) and dropped any refund object without
Saleor metadata as "created outside of Saleor". A merchant who refunded a customer in Stripe was
left with an order that Saleor still counted as fully paid, a granted refund stuck at pending, no
refund notification, and wrong accounting exports — with no way to correct it from the Dashboard.

After: the app also listens to `refund.created`, `refund.updated` and `refund.failed`, and
processes refund events whose payment intent it recorded even when the refund carries no Saleor
metadata. Such refunds are reported under the **refund** id rather than the payment-intent id, so
several external refunds of the same intent stay distinct (Saleor deduplicates transaction events
by pspReference + type). Refunds started from Saleor keep reporting under the payment-intent id —
that is the pspReference Saleor put on the REFUND_REQUEST event, and a mismatch would leave the
request pending forever.

A refund event for a payment intent this app never recorded is still rejected (400, no retry), and
an unknown/missing refund status now returns a malformed-event error instead of throwing a 500 that
Stripe would retry indefinitely.
