---
"saleor-app-checkout-prices": patch
---

Add-to-cart failures now say why. When `checkoutLinesAdd` rejects a line, Saleor returns the
reason (insufficient stock, quantity over the limit, variant unavailable in the channel, …) —
both cart endpoints threw that away and answered with the fixed string "Adding lines to checkout
has failed", which told the shopper nothing and left no trace to debug from. Before: a shopper
saw an unactionable error and the logs held one generic line. After: the response and the log
carry Saleor's own error codes and messages, plus the checkout, variant and quantity involved.

Also fixes a mis-referenced variable in the transport-error branch of `/api/add-to-cart`, which
logged the (unrelated, usually empty) checkout-query error instead of the mutation error that
had just failed.
