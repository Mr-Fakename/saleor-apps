---
"saleor-app-payment-stripe": patch
---

Capturing or cancelling a payment from the Dashboard twice no longer undoes the first action.
- **Before:** a second capture of a payment that was already captured (a double click, the app and staff at the same time, a retry) got "already captured" from Stripe. The app reported that as a failed capture under the payment's own reference, and Saleor then dropped the earlier capture: the order showed 0 captured. A second cancel brought a released authorization back in the same way.
- **After:** the app reads the payment in Stripe first. An already captured payment is reported as captured again (no second capture), and an already cancelled payment as cancelled again. A failure the app reports now has a reference of its own, so it never changes an amount Saleor has recorded.

A partial capture now captures the amount you ask for.
- **Before:** "Capture" for less than the authorized amount captured the whole authorization.
- **After:** the app captures the amount in the request, at most what Stripe can still capture. Stripe releases the rest of the authorization. Saleor still shows that rest as "authorized" on the transaction; nothing can be captured or cancelled from it.

Other changes:
- Capturing a payment whose authorization expired or was released now says "authorization released or expired". The transaction keeps its Cancel action: cancelling it then records the release in Saleor.
- Cancelling a captured payment now says "already captured: refund instead" and offers a refund.
- A payment that is still processing in Stripe is not captured or cancelled yet: the app asks Saleor to send the request again.
- When Stripe does not answer (timeout, Stripe error, the same request still running), the app answers HTTP 503 instead of a failure. Saleor then sends the same request again, up to 5 times in about 5 minutes, and the app checks the payment in Stripe again before it does anything.
- A cancel that Stripe refused no longer blocks a later cancel of the same payment for 24 hours once the payment's status has changed (for example when the payment is authorized).
