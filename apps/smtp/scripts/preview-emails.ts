/**
 * Renders every default SMTP-app email template with sample data and compiles
 * the MJML to HTML, writing previews to <repo>/docs/email-previews/.
 *
 * It mirrors the real pipeline: Handlebars (with handlebars-helpers, as the app
 * registers) → MJML compile. So a clean run here also VALIDATES that the
 * design-system rewrite produces compilable MJML.
 *
 * Run from apps/smtp:  pnpm exec tsx scripts/preview-emails.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Handlebars from "handlebars";
import handlebarsHelpers from "handlebars-helpers";
import mjml2html from "mjml";

import {
  defaultMjmlSubjectTemplates,
  defaultMjmlTemplates,
} from "../src/modules/smtp/default-templates";

handlebarsHelpers({ handlebars: Handlebars });

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../../../docs/email-previews");
mkdirSync(outDir, { recursive: true });

// Sample context covering both camelCase (webhook) and snake_case (NOTIFY)
// payload shapes, plus account/withdrawal/export variables.
const line = (qty: number, productName: string, variantName: string, amount: string) => ({
  quantity: qty,
  productName,
  variantName,
  product_name: productName,
  variant_name: variantName,
  totalPrice: { gross: { amount, currency: "EUR" } },
  total_price: { gross: { amount, currency: "EUR" } },
});

const order = {
  number: "1042",
  email: "client@example.com",
  lines: [line(1, "Perceuse sans fil 18V", "Coffret + 2 batteries", "189.00"), line(2, "Forets HSS", "Lot de 10", "24.50")],
  shippingPrice: { gross: { amount: "9.90", currency: "EUR" } },
  shipping_price: { gross: { amount: "9.90", currency: "EUR" } },
  total: { gross: { amount: "247.90", currency: "EUR" } },
  billingAddress: { streetAddress1: "12 Rue de la Paix, 75002 Paris" },
  shippingAddress: { streetAddress1: "12 Rue de la Paix, 75002 Paris" },
  billing_address: { street_address_1: "12 Rue de la Paix, 75002 Paris" },
  shipping_address: { street_address_1: "12 Rue de la Paix, 75002 Paris" },
};

const context = {
  order,
  user: { first_name: "Camille", language_code: "fr" },
  new_email: "nouvelle@example.com",
  confirm_url: "https://www.dess-equipement.com/confirm?token=demo",
  reset_url: "https://www.dess-equipement.com/reset?token=demo",
  redirect_url: "https://www.dess-equipement.com/confirm?token=demo",
  password_set_url: "https://www.dess-equipement.com/set-password?token=demo",
  csv_link: "https://www.dess-equipement.com/exports/demo.csv",
  fulfillment: { tracking_number: "FR123456789" },
  downloadLinks: [
    { productName: "Guide d'entretien", variantName: "PDF", downloadUrl: "https://www.dess-equipement.com/dl/demo", expiresAt: "2026-07-01" },
  ],
  // Withdrawal
  customer_first_name: "Camille",
  customer_last_name: "Durand",
  recipient_email: "client@example.com",
  order_number: "1042",
  order_created: "2026-06-01",
  order_total: "247.90",
  order_currency: "EUR",
  reference: "RET-2026-0042",
  requested_at: "2026-06-03",
  reason: "Article ne correspondant pas à mes attentes",
};

const events = Object.keys(defaultMjmlTemplates) as (keyof typeof defaultMjmlTemplates)[];
const results: { event: string; ok: boolean; subject: string; detail?: string }[] = [];

for (const event of events) {
  try {
    const renderedMjml = Handlebars.compile(defaultMjmlTemplates[event])(context);
    const { html, errors } = mjml2html(renderedMjml, { validationLevel: "soft" });
    if (errors && errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("; "));
    const subject = Handlebars.compile(defaultMjmlSubjectTemplates[event])(context);
    writeFileSync(join(outDir, `${event}.html`), html, "utf8");
    results.push({ event, ok: true, subject });
  } catch (e) {
    results.push({ event, ok: false, subject: "", detail: e instanceof Error ? e.message : String(e) });
  }
}

const okCount = results.filter((r) => r.ok).length;
const index = `<!doctype html><meta charset="utf-8"><title>Dess email previews</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#f5f4f2;color:#1c1917;max-width:760px;margin:40px auto;padding:0 20px}
h1{font-weight:600;letter-spacing:-.02em}a{color:#003db0;text-decoration:none}li{margin:6px 0}.bad{color:#b91c1c}</style>
<h1>Dess — email previews</h1><p>${okCount}/${results.length} templates compiled.</p><ul>
${results.map((r) => `<li>${r.ok ? `<a href="./${r.event}.html">${r.event}</a> — <em>${r.subject}</em>` : `<span class="bad">${r.event} — FAILED: ${r.detail}</span>`}</li>`).join("\n")}
</ul>`;
writeFileSync(join(outDir, "index.html"), index, "utf8");

for (const r of results) console.log(`${r.ok ? "OK  " : "FAIL"} ${r.event}${r.ok ? "" : " :: " + r.detail}`);
console.log(`\n${okCount}/${results.length} compiled → ${outDir}`);
if (okCount !== results.length) process.exit(1);
