---
"saleor-app-checkout-prices": patch
---

Configured cables now carry proof that the app priced them.
- **Before:** anyone could add the cable base variant through Saleor's public API with a forged configuration in the line metadata (for example a 50 m cable), pay only the assembly fee, and the order showed that configuration as if it were real.
- **After:** when the app adds a configured cable, it also writes a private record of the configuration it priced on the line (`checkout_prices.cable_config`, private metadata). Saleor copies it onto the order line. The Dashboard's cable dialog compares the two and warns "Unverified configuration" when they do not match. Each cable line also gets a public `cable_line_ref`, so the app always marks the line it created.

Changing a stale PayPal fee line no longer removes the fee for a moment.
- **Before:** a fee line with an old amount was deleted and then added again. Between the two calls, the checkout had no fee.
- **After:** when there is exactly one fee line, the app changes its price, quantity and marker in one `checkoutLinesUpdate` call. With no fee line, or more than one, the app still deletes them and adds one.

Cable names and failures.
- **Before:** the names of the connectors, cable, sleeve and variant came from the request, so a customer could put expensive-looking names on cheap parts, and a failed record write still left an unmarked cable in the cart.
- **After:** every name (and the direction and length labels) is Saleor's own, in the checkout's language, and the direction must be a value of the direction attribute of the base variant. If the private record cannot be written, the new line is removed and the call answers 503 "please retry".
