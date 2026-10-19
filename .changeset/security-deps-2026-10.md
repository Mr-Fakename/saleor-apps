---
"saleor-app-smtp": patch
"saleor-app-payment-stripe": patch
"saleor-app-checkout-prices": patch
"saleor-app-customer-extensions": patch
"saleor-app-digital-downloads": patch
"saleor-app-b2b-tax-manager": patch
"saleor-app-products-feed": patch
"invoices": patch
---

Security updates, no behaviour change. Next.js 15.2.4 → 15.5.28 (fixes the image-optimizer
remote code execution, SSRF and middleware-bypass advisories; Next 15 support ends
2026-10-21), and the invoices app's Next.js 14.2.3 → 14.2.35 (critical middleware bypass).
Handlebars 4.7.7 → 4.7.10 for the email and products-feed templates (critical JS injection),
pinned for every copy in the tree. The email app's nodemailer 6.9.1 → 10.1.7 (a pre-auth
denial of service and address-parsing flaws that could deliver mail to the wrong recipient);
sending, TLS, attachments and address parsing were compared against 6.9.1 and behave the
same. The customer-extensions image moves from Node 20 (end of life) to Node 22.
