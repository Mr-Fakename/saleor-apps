---
"saleor-app-checkout-prices": patch
---

The PayPal fee is now computed by the app, not taken from the request.
- **Before:** `/api/payment-fee` charged whatever `amount` the caller sent.
- **After:** the fee is `PAYMENT_FEE_RATE_PERCENT` (default 1.5) of the checkout total, excluding fee lines, rounded half-up to the cent. A repeated call leaves exactly one fee line.

Configured cables are now checked against the catalog.
- **Before:** any variant could be the base line or a component, and a length of -5, 0 or 999999 was accepted.
- **After:**
  - the base variant must belong to `CABLE_PRODUCT_SLUG`;
  - each component must be one of the options that variant offers;
  - every component needs a price;
  - the length must be within `CABLE_MIN_LENGTH_CM`–`CABLE_MAX_LENGTH_CM` (10–5000);
  - the quantity must be a whole number from 1 to 999.

The public endpoints now only allow browser calls from `ALLOWED_ORIGINS`. Server-to-server calls (no Origin) still work. **Set `ALLOWED_ORIGINS` to the storefront origin before deploying**, or the browser's PayPal fee call gets 403.

The unauthenticated `/api/setup-db` route is removed. The DynamoDB table is created at startup when `INIT_DYNAMODB_ON_STARTUP=true`.
