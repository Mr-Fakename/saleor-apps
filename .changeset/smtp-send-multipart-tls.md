---
"saleor-app-smtp": patch
---

Improve deliverability of the `/api/send` endpoint. Emails are now sent as a proper
`multipart/alternative` message — a `text/plain` part is derived from the HTML instead of
sending HTML-only — and the SMTP connection enforces STARTTLS with a TLS 1.2+ minimum.
HTML-only bodies and legacy TLS are common spam-filter signals, especially at French ISPs
(Orange/Free, which filter via Vade). Before: download/bridge emails went out HTML-only over
opportunistic TLS. After: every `/api/send` email carries a plain-text alternative and is sent
over enforced modern TLS.
