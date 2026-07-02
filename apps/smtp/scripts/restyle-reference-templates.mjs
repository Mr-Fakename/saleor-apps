/**
 * One-shot restyle of the root email-templates/*.mjml reference set (the
 * paste-into-Dashboard, multi-language copies) to the Dess storefront look,
 * consistent with the live SMTP-app design system. Anchored, idempotent-ish
 * regex transforms; preserves the i18n {{#eq ...}} content blocks. Validates
 * each result by compiling MJML before writing.
 *
 * Run from apps/smtp:  node scripts/restyle-reference-templates.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import mjml2html from "mjml";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../../../../email-templates");

const LOGO = "https://www.dess-equipement.com/logo-dess-2023.png";

const HEAD = `<mj-head>
    <mj-attributes>
      <mj-all font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" />
      <mj-text font-size="15px" line-height="1.65" color="#44403c" />
      <mj-section padding="0" />
    </mj-attributes>
    <mj-font name="Inter" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
    <mj-raw>
      <meta name="color-scheme" content="light dark" />
      <meta name="supported-color-schemes" content="light dark" />
    </mj-raw>
    <mj-style>
      a { color:#003db0; text-decoration:none; }
      @media (prefers-color-scheme: dark) {
        .dk-body { background:#1c1917 !important; }
        .dk-card { background:#292524 !important; }
        .dk-card div { color:#d6d3d1 !important; }
        .dk-card a { color:#9bbcf2 !important; }
        a { color:#9bbcf2 !important; }
      }
    </mj-style>
  </mj-head>`;

const HEADER = `<mj-section padding="32px 24px 8px">
      <mj-column>
        <mj-image src="${LOGO}" alt="Dess" width="116px" align="center" padding="0" />
        <mj-spacer height="14px" />
        <mj-divider border-width="2px" border-color="#003db0" width="40px" padding="0" />
      </mj-column>
    </mj-section>`;

const FOOTER = `<mj-section padding="8px 24px 36px" css-class="dk-body">
      <mj-column>
        <mj-text align="center" color="#78716c" font-size="13px" line-height="1.7">
          <strong style="color:#44403c;">Dess</strong><br/>
          <a href="mailto:contact@dess-equipement.com" style="color:#003db0;">contact@dess-equipement.com</a> &nbsp;&middot;&nbsp; +33 6 63 65 72 70
        </mj-text>
        <mj-text align="center" color="#78716c" font-size="13px" padding="6px 0 0">
          <a href="https://www.instagram.com/" style="color:#78716c;">Instagram</a> &nbsp;&middot;&nbsp; <a href="https://www.facebook.com/" style="color:#78716c;">Facebook</a>
        </mj-text>
        <mj-text align="center" color="#a8a29e" font-size="12px" padding="14px 0 0">
          <a href="https://www.dess-equipement.com/mentions-legales" style="color:#a8a29e;">Mentions l&eacute;gales</a> &nbsp;&middot;&nbsp; <a href="https://www.dess-equipement.com/confidentialite" style="color:#a8a29e;">Confidentialit&eacute;</a> &nbsp;&middot;&nbsp; <a href="https://www.dess-equipement.com/retractation" style="color:#a8a29e;">R&eacute;tractation</a>
        </mj-text>
        <mj-text align="center" color="#a8a29e" font-size="11px" padding="10px 0 0">&copy; Dess &mdash; Tous droits r&eacute;serv&eacute;s.</mj-text>
      </mj-column>
    </mj-section>`;

const COLOR_SWAPS = [
  [/#111827/g, "#1c1917"],
  [/#f9fafb/g, "#f5f4f2"],
  [/#9ca3af/g, "#a8a29e"],
  [/#374151/g, "#44403c"],
  [/#6b7280/g, "#78716c"],
  [/background-color="#3b82f6"/g, 'background-color="#003db0"'],
];

const files = readdirSync(dir).filter((f) => f.endsWith(".mjml"));
let okCount = 0;

for (const file of files) {
  const path = join(dir, file);
  let s = readFileSync(path, "utf8");

  // Guard: skip files already transformed (re-running must not double-inject).
  if (s.includes('css-class="dk-body"')) {
    console.log(`SKIP ${file} (already restyled)`);
    okCount++;
    continue;
  }

  s = s.replace(/<mj-head>[\s\S]*?<\/mj-head>/, HEAD);
  s = s.replace(/<mj-section padding="40px 0 20px">[\s\S]*?<\/mj-section>/, HEADER);
  s = s.replace(/<mj-section padding="20px 0 40px">[\s\S]*?<\/mj-section>/, FOOTER);
  s = s.replace(
    /<mj-body background-color="#f9fafb">/,
    '<mj-body background-color="#f5f4f2" css-class="dk-body" width="600px">',
  );
  s = s.replace(
    /background-color="#ffffff" border-radius="16px"/g,
    'background-color="#ffffff" border-radius="16px" css-class="dk-card"',
  );
  for (const [re, to] of COLOR_SWAPS) s = s.replace(re, to);

  const { errors } = mjml2html(s, { validationLevel: "soft" });
  if (errors && errors.length) {
    console.log(`FAIL ${file} :: ${errors.map((e) => e.formattedMessage).join("; ")}`);
    continue;
  }
  writeFileSync(path, s, "utf8");
  console.log(`OK   ${file}`);
  okCount++;
}
console.log(`\n${okCount}/${files.length} reference templates restyled.`);
if (okCount !== files.length) process.exit(1);
