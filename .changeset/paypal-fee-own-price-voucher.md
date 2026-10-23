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
