/**
 * Dess email design system — the SINGLE source of truth for the look & feel of
 * every transactional email the SMTP app sends.
 *
 * Why a TypeScript builder and not `<mj-include>` partials: the SMTP app compiles
 * MJML from an in-memory STRING (see services/mjml-compiler.ts → `mjml(string)`),
 * and MJML's `<mj-include>` only resolves against the filesystem. So the only way
 * to genuinely share chrome across templates (rather than copy-paste) is to
 * compose the MJML string in TS. Every template in default-templates.ts is built
 * by calling `wrapEmail({ preheader, body })` with a small body fragment.
 *
 * The palette + typography are lifted verbatim from the storefront
 * (saleor-storefront/tailwind.config.ts) so emails feel like an extension of the
 * site: accent #003db0, the warm `neutral` scale, Inter, -0.02em display tracking.
 *
 * Email-client realities handled here, once:
 *   - table-based layout + inline CSS (MJML's whole job),
 *   - Inter web font with a full system fallback stack,
 *   - mobile-responsive (MJML default 600px + fluid columns),
 *   - dark-mode aware (color-scheme meta + a prefers-color-scheme override that
 *     re-skins the .dk-* hooks the builders attach),
 *   - a hidden preheader (inbox preview line),
 *   - plaintext fallback is derived downstream by html-to-text-compiler.ts.
 *
 * Handlebars placeholders ({{ ... }}, {{#if}}, {{#each}}, {{#eq}}) pass straight
 * through — Handlebars runs BEFORE MJML in the pipeline, so fragments may contain
 * any template syntax.
 */

export const dessEmail = {
  brandName: "Dess",
  // Absolute URL — email clients can't resolve site-relative paths.
  logoUrl: "https://www.dess-equipement.com/logo-dess-2023.png",
  logoWidth: "116px",
  siteUrl: "https://www.dess-equipement.com",
  contactEmail: "contact@dess-equipement.com",
  // Footer contact line. Adjust the phone to the real one when known.
  phone: "+33 6 63 65 72 70",
  social: [
    { label: "Instagram", href: "https://www.instagram.com/" },
    { label: "Facebook", href: "https://www.facebook.com/" },
  ],
  legal: [
    { label: "Mentions légales", href: "https://www.dess-equipement.com/mentions-legales" },
    { label: "Confidentialité", href: "https://www.dess-equipement.com/confidentialite" },
    { label: "Rétractation", href: "https://www.dess-equipement.com/retractation" },
  ],
} as const;

/** Palette — straight from the storefront tailwind config. */
export const c = {
  page: "#f5f4f2", // warm page background
  card: "#ffffff",
  border: "#e7e5e4", // neutral-200
  ink: "#1c1917", // neutral-900 — headings
  body: "#44403c", // neutral-700 — body copy
  muted: "#78716c", // neutral-500
  faint: "#a8a29e", // neutral-400
  accent: "#003db0", // accent-800 — primary
  accentDark: "#1f4ba8", // accent-700 — hover/pressed
  accentSoft: "#f0f5ff", // accent-50 — tints / highlight panels
} as const;

const FONT_STACK =
  "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/**
 * Shared <mj-head>: web font, sensible component defaults, and the dark-mode
 * stylesheet. The .dk-* classes are attached by the component builders below.
 */
const head = (preheader?: string): string => `
  <mj-head>
    <mj-title>${dessEmail.brandName}</mj-title>
    <mj-preview>${preheader ?? ""}</mj-preview>
    <mj-font name="Inter" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
    <mj-attributes>
      <mj-all font-family="${FONT_STACK}" />
      <mj-text font-size="15px" line-height="1.65" color="${c.body}" font-weight="400" />
      <mj-section padding="0" />
      <mj-class name="dk-text" color="${c.body}" />
    </mj-attributes>
    <mj-raw>
      <meta name="color-scheme" content="light dark" />
      <meta name="supported-color-schemes" content="light dark" />
    </mj-raw>
    <mj-style>
      a { color: ${c.accent}; text-decoration: none; }
      .brand-rule { line-height: 0; }
      @media (prefers-color-scheme: dark) {
        .dk-body { background: #1c1917 !important; }
        .dk-card { background: #292524 !important; }
        .dk-card td { border-color: #3a3531 !important; }
        .dk-ink div { color: #f5f5f4 !important; }
        .dk-text div { color: #d6d3d1 !important; }
        .dk-muted div { color: #a8a29e !important; }
        .dk-panel { background: #2b2f3a !important; }
        .dk-divider p { border-color: #3a3531 !important; }
        a { color: #9bbcf2 !important; }
      }
    </mj-style>
  </mj-head>`;

/** Branded header: centered logo + a short accent rule. */
const header = (): string => `
    <mj-section padding="32px 24px 8px">
      <mj-column>
        <mj-image src="${dessEmail.logoUrl}" alt="${dessEmail.brandName}" width="${dessEmail.logoWidth}" align="center" padding="0" />
        <mj-spacer height="14px" />
        <mj-divider border-width="2px" border-color="${c.accent}" width="40px" padding="0" css-class="brand-rule" />
      </mj-column>
    </mj-section>`;

/** Footer: contact, social, legal, copyright — fr_FR. */
const footer = (): string => `
    <mj-section padding="8px 24px 36px">
      <mj-column>
        <mj-text align="center" color="${c.muted}" font-size="13px" line-height="1.7" css-class="dk-muted">
          <strong style="color:${c.body};">${dessEmail.brandName}</strong><br/>
          <a href="mailto:${dessEmail.contactEmail}" style="color:${c.accent};">${dessEmail.contactEmail}</a> &nbsp;·&nbsp; ${dessEmail.phone}
        </mj-text>
        <mj-text align="center" color="${c.muted}" font-size="13px" padding="6px 0 0" css-class="dk-muted">
          ${dessEmail.social.map((s) => `<a href="${s.href}" style="color:${c.muted};">${s.label}</a>`).join(" &nbsp;·&nbsp; ")}
        </mj-text>
        <mj-text align="center" color="${c.faint}" font-size="12px" padding="14px 0 0" css-class="dk-muted">
          ${dessEmail.legal.map((l) => `<a href="${l.href}" style="color:${c.faint};">${l.label}</a>`).join(" &nbsp;·&nbsp; ")}
        </mj-text>
        <mj-text align="center" color="${c.faint}" font-size="11px" padding="10px 0 0" css-class="dk-muted">
          © ${dessEmail.brandName} — Tous droits réservés.
        </mj-text>
      </mj-column>
    </mj-section>`;

/**
 * Compose a full email: header → white content card (the `body` fragment) →
 * footer, on the warm page background. `body` should be a sequence of MJML
 * elements (mj-text/mj-button/etc.) — they're dropped into a single mj-column.
 */
export const wrapEmail = ({ preheader, body }: { preheader?: string; body: string }): string => `<mjml>
  ${head(preheader)}
  <mj-body background-color="${c.page}" css-class="dk-body" width="600px">
    ${header()}
    <mj-section padding="0 24px">
      <mj-column background-color="${c.card}" border="1px solid ${c.border}" border-radius="16px" padding="36px 32px" css-class="dk-card">
${body}
      </mj-column>
    </mj-section>
    ${footer()}
  </mj-body>
</mjml>`;

// ---------------------------------------------------------------------------
// Content component builders — return MJML fragment strings for use in `body`.
// ---------------------------------------------------------------------------

/** Display heading (the email's title). */
export const heading = (text: string): string =>
  `        <mj-text css-class="dk-ink" color="${c.ink}" font-size="22px" font-weight="600" line-height="1.3" letter-spacing="-0.02em" padding="0 0 14px">${text}</mj-text>`;

/** A friendly eyebrow/greeting line above the heading. */
export const greeting = (text: string): string =>
  `        <mj-text css-class="dk-muted" color="${c.muted}" font-size="13px" font-weight="600" text-transform="uppercase" letter-spacing="0.06em" padding="0 0 6px">${text}</mj-text>`;

/** Body paragraph. `html` may contain inline Handlebars + <strong>/<br/>. */
export const text = (html: string, padding = "0 0 14px"): string =>
  `        <mj-text css-class="dk-text" color="${c.body}" padding="${padding}">${html}</mj-text>`;

/** Primary call-to-action button. */
export const button = (href: string, label: string): string =>
  `        <mj-button href="${href}" background-color="${c.accent}" color="#ffffff" font-size="15px" font-weight="600" inner-padding="14px 30px" border-radius="10px" align="left" padding="10px 0 6px">${label}</mj-button>`;

/** Highlight panel (e.g. digital downloads, tracking, reference info). */
export const panel = (inner: string): string => `        <mj-table css-class="dk-panel" cellpadding="0" cellspacing="0" padding="16px 0 6px">
          <tr><td style="background:${c.accentSoft};border:1px solid ${c.border};border-radius:12px;padding:18px 20px;">${inner}</td></tr>
        </mj-table>`;

/** Thin divider between sections. */
export const divider = (): string =>
  `        <mj-text css-class="dk-divider" padding="6px 0 16px"><p style="border-top:1px solid ${c.border};margin:0;font-size:0;line-height:0;">&nbsp;</p></mj-text>`;

/**
 * Order-summary table (line items + shipping + total). `snake` selects the
 * NOTIFY payload field casing (snake_case) vs the GraphQL webhook one (camelCase).
 */
export const orderSummary = ({ snake = false }: { snake?: boolean } = {}): string => {
  const f = snake
    ? { name: "product_name", variant: "variant_name", qty: "quantity", line: "total_price", ship: "shipping_price", shipName: "shipping_method_name", total: "total" }
    : { name: "productName", variant: "variantName", qty: "quantity", line: "totalPrice", ship: "shippingPrice", shipName: "shippingMethodName", total: "total" };
  return `        <mj-text css-class="dk-muted" color="${c.muted}" font-size="13px" font-weight="600" text-transform="uppercase" letter-spacing="0.06em" padding="18px 0 8px">Récapitulatif</mj-text>
        <mj-table css-class="dk-text" color="${c.body}" font-size="14px" cellpadding="0" cellspacing="0" padding="0">
          {{#each order.lines}}
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid ${c.border};color:${c.body};">{{ this.${f.qty} }} × {{ this.${f.name} }}{{#if this.${f.variant}}} — {{ this.${f.variant} }}{{/if}}</td>
            <td align="right" style="padding:8px 0;border-bottom:1px solid ${c.border};color:${c.ink};white-space:nowrap;">{{ this.${f.line}.gross.amount }} {{ this.${f.line}.gross.currency }}</td>
          </tr>
          {{/each}}
          <tr>
            <td style="padding:8px 0;color:${c.muted};">Livraison{{#if order.${f.shipName}}} &mdash; {{ order.${f.shipName} }}{{/if}}</td>
            <td align="right" style="padding:8px 0;color:${c.muted};white-space:nowrap;">{{ order.${f.ship}.gross.amount }} {{ order.${f.ship}.gross.currency }}</td>
          </tr>
          <tr>
            <td style="padding:12px 0 0;border-top:2px solid ${c.border};color:${c.ink};font-weight:600;font-size:16px;">Total</td>
            <td align="right" style="padding:12px 0 0;border-top:2px solid ${c.border};color:${c.accent};font-weight:600;font-size:16px;white-space:nowrap;">{{ order.${f.total}.gross.amount }} {{ order.${f.total}.gross.currency }}</td>
          </tr>
        </mj-table>`;
};

/** Billing / shipping address block. `snake` as above. */
export const addresses = ({ snake = false }: { snake?: boolean } = {}): string => {
  const billing = snake ? "billing_address" : "billingAddress";
  const shipping = snake ? "shipping_address" : "shippingAddress";
  const street = snake ? "street_address_1" : "streetAddress1";
  return `        <mj-table css-class="dk-text" color="${c.body}" font-size="14px" cellpadding="0" cellspacing="0" padding="18px 0 0">
          <tr>
            <td style="padding:0 12px 4px 0;color:${c.muted};font-size:12px;text-transform:uppercase;letter-spacing:0.06em;width:50%;">Facturation</td>
            <td style="padding:0 0 4px 12px;color:${c.muted};font-size:12px;text-transform:uppercase;letter-spacing:0.06em;width:50%;">Livraison</td>
          </tr>
          <tr>
            <td style="padding:0 12px 0 0;color:${c.body};vertical-align:top;">{{#if order.${billing}}}{{ order.${billing}.${street} }}{{else}}—{{/if}}</td>
            <td style="padding:0 0 0 12px;color:${c.body};vertical-align:top;">{{#if order.${shipping}}}{{ order.${shipping}.${street} }}{{else}}Aucune livraison requise{{/if}}</td>
          </tr>
        </mj-table>`;
};
