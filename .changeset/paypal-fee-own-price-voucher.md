---
"saleor-app-stripe": patch
"saleor-app-checkout-prices": patch
---

PayPal works again when a voucher on the whole order is on the checkout (PayPal-fee gate on).
- **Before:** Saleor spreads an ENTIRE_ORDER voucher (or an order promotion) over every line, the PayPal fee line included. The fee line then showed less than the fee (for example 1.36 shown as 1.22), the Stripe app refused the payment with "The PayPal fee on the checkout is out of date", and applying the fee again wrote the same amount, which Saleor reduced again. The shopper could not pay with PayPal. The capture rule would also have held such an order (`fee-invalid`).
- **After:** the Stripe app checks the fee line's own price (its price before discounts) against the fee, and accepts a reduced line total between 0 and that price. The base of the fee is unchanged, so a fee written for an old total is still refused. The capture rule (R12) checks the order the same way. With a voucher, the shopper pays the fee minus the voucher's share, never more than the rule allows.

checkout-prices now replaces a stale fee line instead of changing its price.
- **Before:** a fee line with an old amount was changed in place with one `checkoutLinesUpdate`. Saleor 3.22 can keep an old copy of a line's own price after such a change, which the new check would read.
- **After:** the app adds the new fee line, then deletes the fee lines it read, then keeps the oldest fee line if a concurrent call added one. The checkout is never without a fee line: for a moment it holds two, which the Stripe app refuses. If the voucher spread moves the fee after the write, the app replaces the line again (at most twice more). A failed add changes nothing; a failed delete answers 409 and the next call repairs it.

`/api/add-to-cart` and `/api/update-line-quantity` no longer touch the payment-fee variant (`PAYMENT_FEE_VARIANT_ID`): they answer 400 instead of setting a quantity or a quantity-tier price on the fee line. Removing a line with quantity 0 still works.

Two effects on what shoppers pay (decided, not side effects):
- **A voucher also reduces the PayPal fee.** A voucher on the whole order is spread over the fee line too, so the shopper pays the fee minus the voucher's share. An "apply once per order" voucher goes to the cheapest line, usually the fee line: do not offer such vouchers while the PayPal-fee gate is on.
- **Tax-exempt shoppers pay the fee net of VAT.** With prices entered with tax and a tax exemption, the fee is 1.5 % of the net total, and Saleor charges the fee line net too (a 15.00 fee shows 12.50 at 20 % VAT). The Stripe app accepts it, because the fee line's own price is still the fee. This is what shoppers already pay with the gate off.

Deploy order: checkout-prices before or together with the Stripe app, then the storefront. Turn the PayPal-fee gate on at least 1 h after the new checkout-prices is live: a fee line the old version changed in place can keep an old own price in Saleor, usually for up to `CHECKOUT_PRICES_TTL` (1 h by default) and longer under a rare pattern of requests. So also run the pre-flip check in ops runbook 06 §7.6 (no fee line whose stored own price differs from its price override). Turning the gate off is a full rollback only together with the previous checkout-prices image (ops runbook 06 §7.6).
