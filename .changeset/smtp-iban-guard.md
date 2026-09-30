---
"saleor-app-smtp": minor
---

Outgoing mail is now checked for bank account numbers (IBANs), against IBAN-swap fraud. Every
email the app sends (`/api/send`, `/api/send-event` and every Saleor event) is scanned. Any IBAN
that is not pinned in `src/modules/iban-guard/allowed-ibans.ts` is logged and emailed to
`IBAN_GUARD_ALERT_TO`. In `IBAN_GUARD_MODE=enforce` the email is also not sent (`/api/send`
answers 422; a blocked event email is a no-op, so Saleor does not retry it). The default is
`monitor`: send and alert. Before: anyone with the send key, or with access to the templates,
could put their own IBAN in front of customers from the shop's real address, and nobody would
know. After: that raises an alert, and in enforce mode it is stopped. Emails without an IBAN are
never affected, and the guard fails open if it cannot inspect an email.

Also hardens `/api/send`: `to`, `subject` and `html` must be strings, and the transport has
`disableFileAccess`/`disableUrlAccess` set. Before, a caller with the key could pass
`html: { path: "/app/.env" }` and nodemailer would mail them a file from the container.
