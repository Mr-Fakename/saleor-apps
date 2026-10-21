---
"saleor-app-digital-downloads": patch
---

`ORDER_FULLY_PAID` webhooks must now carry a valid Saleor signature.
- **Before:** a failed signature check was logged and the webhook was accepted anyway. A forged request could mint download links for any product, email them to any address, and store an arbitrary file URL.
- **After:** the SDK's default verification applies (JWKS refreshed once on failure), and a forged or invalid signature gets a 401 before the handler runs.

The `debug-apl`, `debug-auth` and `setup-db` routes are removed. The `OrderIndex` index, which the order-downloads lookup needs, is now created at startup together with the table. Before, only a manual script created it.
