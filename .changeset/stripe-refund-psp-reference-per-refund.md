---
"saleor-app-payment-stripe": patch
---

Each Stripe refund now has its own line in Saleor's refund ledger. Before: the app reported
every refund under the payment's PaymentIntent id. Saleor keeps only one event per reference
and type, so a second refund on the same payment was dropped (same amount) or rejected
(different amount), and the order's refunded amount showed less than Stripe really refunded.
After: the app answers each refund request with the Stripe refund id (`re_…`), and reports
every later Stripe update of that refund (created, updated, failed, also for refunds made in
the Stripe dashboard) under the same id. Payment and authorization events keep the
PaymentIntent id.

Refunds recorded before this release keep their old reference. Before the app reports a
refund it created, it reads the transaction's events from Saleor. When Saleor recorded that
refund under the PaymentIntent (an event that links to this refund, or the refund request of
the same amount made just before the refund), a later Stripe update of it is reported under
the PaymentIntent as before, so it cannot count the refund twice. If Saleor cannot be read,
the app answers Stripe with an error and Stripe sends the update again later.

A refund the app made is now linked to its granted refund even when Stripe reports it early.
Before: when Stripe's refund event arrived before Saleor had stored the app's answer (for
example while Saleor was still retrying the request), the refund was recorded without its
granted refund, which then stayed "pending" for good and could not be retried or edited.
After: for up to 10 minutes after the refund was made, the app waits for Saleor to store its
answer. Until then it answers Stripe with an error, and Stripe sends the event again later.
After 10 minutes the refund is recorded as before, so no refund is lost. Refunds made in the
Stripe dashboard are not delayed.

A granted refund now ends as "succeeded" when Stripe answers within the same second. Before:
Stripe gives the time of a refund update in whole seconds, and Saleor's refund request has
fractions of a second. When Stripe made the refund in the same second as the request, the
success looked older than the request, so the granted refund stayed "pending". After: the app
reports each update of such a refund at least 1 millisecond after Saleor's request, so a
success shows "succeeded" and a later failure still shows "failed". Refunds recorded before
this release and refunds made in the Stripe dashboard keep Stripe's time.

A refund the app could not make now always gets a new reference of its own. Before: a Stripe
error was reported under the PaymentIntent, and a refusal by the app had no reference. Saleor
then merged a retried refund's failure into the earlier failure, and the granted refund stayed
"pending" for good and could not be retried. Saleor could also attach the failure to an older
failure without a reference and show its own message instead of the app's. After: every such
failure has a unique reference (`refund-failure-…`), keeps the app's message and Stripe link,
and sets the granted refund to "failed", so staff can retry it.

When Stripe gives no clear answer, the app no longer reports a failure. Before: a network
error, a timeout or a Stripe server error was reported as a failed refund, although Stripe may
have made the refund, which invited staff to refund again. After: the app answers Saleor with
HTTP 503. Saleor then sends the same request again, up to 5 times over about 5 minutes, and the
same idempotency key gives back the refund Stripe may have made. The refund call to Stripe now
makes one attempt that stops after 6 seconds (about 12.5 seconds at most when the connection
drops), so the app always answers before Saleor's 20-second limit, and a second attempt can no
longer turn a refund Stripe made into a reported failure.
