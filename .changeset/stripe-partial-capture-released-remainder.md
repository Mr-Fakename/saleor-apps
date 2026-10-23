---
"saleor-app-payment-stripe": patch
---

After a partial capture, Saleor now shows the released rest of the authorization as canceled.

Before: capturing 60 of an authorization of 100 left Saleor showing 40 still "authorized",
although Stripe had already released it (Stripe sends no refund event for it).

After: when Stripe reports the PaymentIntent succeeded with less received than authorized, the app
also reports the difference to Saleor as a cancel success, under the reference `<PaymentIntent
id>:released`. The report is the same every time, so a repeated Stripe event never counts it twice.
Full captures are reported exactly as before. This applies to every shop, with or without the
PayPal-fee gate.
