#!/usr/bin/env node
/**
 * Legacy Review Scraper for dess-equipement.com (Jimdo site)
 *
 * Scrapes all product pages for comments and exports them to a master JSON file.
 * Uses curl subprocess for better Cloudflare TLS fingerprint compatibility.
 *
 * Run: node scripts/scrape-legacy-reviews.mjs
 * Resume after interruption: node scripts/scrape-legacy-reviews.mjs --resume
 * Output: scripts/legacy-reviews.json
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.join(__dirname, "legacy-reviews.json");
const PROGRESS_FILE = path.join(__dirname, ".scrape-progress.json");

const BASE_URL = "https://www.dess-equipement.com";
const RESUME = process.argv.includes("--resume");

// All product page paths from the sitemap (captured 2026-03-03)
// Excludes category pages, blog posts, utility pages, and firmware update pages
const PRODUCT_PATHS = [
  // Switchers
  "/sx-2/",
  "/sp-6/",
  "/sp-6s/",
  "/sp-9/",
  "/sp-9s/",
  "/sp-13/",
  "/sp-13s/",
  "/ts-6/",
  "/ex-9/",
  "/rk-15/",
  "/tw-s-pro/",
  "/tw-sp9/",
  "/tw-sp12/",
  "/tw-ex/",
  // Splitter / Buffer
  "/dy-1/",
  "/sy-1/",
  "/splitter/",
  "/aby-box/",
  // MIDI Controllers
  "/mmc-12/",
  "/mmc-15/",
  "/midi-controller/mc-8s/",
  "/midi-controller/mc-10s/",
  "/midi-controller/mc-12s/",
  "/midi-controller/mx-4/",
  // Alimentations
  "/mp-5/",
  "/mp-8/",
  "/mp-10/",
  "/mp-12/",
  "/mp-16/",
  "/mp-20/",
  "/alimentations/cordon-jack-dc/",
  "/alimentations/inverseur-jack-dc/",
  "/alimentations/convertisseur-jack-dc/",
  "/alimentations/adaptateur-jack-dc/",
  "/alimentations/cordon-y-jack-dc/",
  // LS-1
  "/ls-1/",
  // Pedalboards
  "/hpb-m-360/",
  "/hpb-m-540/",
  "/hpb-m-720/",
  "/hpb-2-360-ol/",
  "/hpb-2-540-ol/",
  "/hpb-2-720-ol/",
  "/hpb-2-900-ol/",
  "/hpb-2-1080-ol/",
  "/hpb-2-360/",
  "/hpb-2-540/",
  "/hpb-2-720/",
  "/hpb-2-900/",
  "/hpb-2-1080/",
  "/hpb-s-540/",
  // Patchbay
  "/hc-4/",
  "/hc-4x/",
  "/hc-4m/",
  "/hc-4m-plus/",
  "/hc-4iec/",
  "/hc-5m/",
  "/hc-6/",
  "/hc-iec/",
  "/hc-rc/",
  "/hc-rb/",
  "/patchbay/hc-ada/",
  "/patchbay/hc-1314/",
  // Cables & Connectors
  "/patch/spc-patch/",
  "/patch/mg-patch/",
  "/patch/slv-patch/",
  "/patch/xps-patch/",
  "/ilc-cable/",
  "/cables-connecteurs/c%C3%A2ble-hp/",
  // Squareplug
  "/squareplug-sp400/",
  "/squareplug-sp500/",
  "/squareplug-sp600/",
  "/squareplug-sp550-s/",
  "/squareplug-sps4/",
  "/squareplug-sps5/",
  "/squareplug-sps6m/",
  "/squareplug-sps6-s/",
  "/squareplug-sps7-s/",
  "/spx-mbk/",
  "/spx-fbk/",
  "/spxa-mbk/",
  "/spxa-fbk/",
  // Cable au metre
  "/mogami-w2319/",
  "/sc-onyx-tynee/",
  "/cable-au-metre/spc0805/",
  "/cable-au-metre/spc4718/",
  "/sc-gobelin/",
  "/cable-au-metre/mogami-w2534/",
  // Kits
  "/kit-10c/",
  "/kit-25c/",
  "/kit-50c/",
  // Accessories
  "/dual-lock/",
  "/embase-serflex/",
  "/flightcase/",
  // Power switchers
  "/hydra-s4/",
  "/switchers-de-puissance/hydra-s8/",
  // Selecteurs symetriques
  "/produits/les-s%C3%A9lecteurs-sym%C3%A9triques/8-canaux-rack-19-1u/",
];

// --- French date parser ---

const FRENCH_MONTHS = {
  janvier: 0,
  "février": 1,
  fevrier: 1,
  mars: 2,
  avril: 3,
  mai: 4,
  juin: 5,
  juillet: 6,
  "août": 7,
  aout: 7,
  septembre: 8,
  octobre: 9,
  novembre: 10,
  "décembre": 11,
  decembre: 11,
};

/**
 * Parse French date like "mercredi, 11 juin 2025 17:58" → ISO string
 */
function parseFrenchDate(dateStr) {
  // Remove day-of-week prefix: "mercredi, " → ""
  const cleaned = dateStr.replace(/^[a-zéû]+,\s*/i, "").trim();
  // Match: "11 juin 2025 17:58"
  const match = cleaned.match(
    /(\d{1,2})\s+([a-zéûô]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})/i,
  );
  if (!match) {
    console.warn(`  Could not parse date: "${dateStr}"`);
    return null;
  }

  const [, day, monthName, year, hour, minute] = match;
  const monthIndex = FRENCH_MONTHS[monthName.toLowerCase()];
  if (monthIndex === undefined) {
    console.warn(`  Unknown French month: "${monthName}"`);
    return null;
  }

  const date = new Date(
    parseInt(year),
    monthIndex,
    parseInt(day),
    parseInt(hour),
    parseInt(minute),
  );
  return date.toISOString();
}

// --- HTML fetcher via curl ---

/**
 * Fetch a page using curl subprocess.
 * curl has better TLS fingerprinting than Node.js https, which helps
 * bypass Cloudflare's bot detection.
 */
function fetchPage(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const html = execSync(
        `curl -s -L --max-time 15 ` +
          `-H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" ` +
          `-H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9" ` +
          `-H "Accept-Language: fr-FR,fr;q=0.9,en-US;q=0.8" ` +
          `-H "Accept-Encoding: identity" ` +
          `-H "Sec-Fetch-Dest: document" ` +
          `-H "Sec-Fetch-Mode: navigate" ` +
          `-H "Sec-Fetch-Site: none" ` +
          `-H "Sec-Fetch-User: ?1" ` +
          `-w "\\n---HTTP_STATUS:%{http_code}---" ` +
          `"${url}"`,
        { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
      );

      // Extract HTTP status from the appended footer
      const statusMatch = html.match(/---HTTP_STATUS:(\d+)---$/);
      const status = statusMatch ? parseInt(statusMatch[1]) : 0;
      const body = html.replace(/\n---HTTP_STATUS:\d+---$/, "");

      if (status === 200) {
        return body;
      }

      if (status === 403 && attempt < retries) {
        // Cloudflare block — wait and retry with exponential backoff
        const wait = attempt * 5000;
        console.log(` [retry ${attempt}/${retries}, wait ${wait / 1000}s]`);
        execSync(`sleep ${wait / 1000}`);
        continue;
      }

      throw new Error(`HTTP ${status}`);
    } catch (err) {
      if (attempt === retries) {
        throw err.message ? err : new Error(`curl failed: ${err.status}`);
      }
    }
  }
}

// --- Comment parser ---

/**
 * Parse Jimdo comment HTML structure:
 *
 * <li id="commentEntry{id}" class="commentstd clearover">
 *   <strong class="number">#{N}</strong>
 *   <p class="com-meta">
 *     <strong>{username}</strong> <span>(<em>{date}</em>)</span>
 *   </p>
 *   <p class="commententry">{content with <br/> tags}</p>
 * </li>
 */
function parseComments(html) {
  const comments = [];

  // Split by comment entries
  const entryRegex =
    /<li\s+id="commentEntry\d+"\s+class="commentstd[^"]*"[^>]*>([\s\S]*?)(?=<li\s+id="commentEntry|<\/ul>)/g;
  let entryMatch;

  while ((entryMatch = entryRegex.exec(html)) !== null) {
    const block = entryMatch[1];

    // Extract number
    const numberMatch = block.match(
      /<strong\s+class="number">#(\d+)<\/strong>/,
    );
    const number = numberMatch ? parseInt(numberMatch[1]) : null;

    // Extract username
    const nameMatch = block.match(
      /<p\s+class="com-meta">\s*<strong>([^<]+)<\/strong>/,
    );
    const userName = nameMatch ? nameMatch[1].trim() : "Unknown";

    // Extract date
    const dateMatch = block.match(/<em>([^<]+)<\/em>/);
    const rawDate = dateMatch ? dateMatch[1].trim() : null;
    const createdAt = rawDate ? parseFrenchDate(rawDate) : null;

    // Extract comment content
    const contentMatch = block.match(
      /<p\s+class="commententry">([\s\S]*?)<\/p>/,
    );
    let comment = "";
    if (contentMatch) {
      comment = contentMatch[1]
        .replace(/<br\s*\/?>/gi, "\n") // br → newline
        .replace(/<[^>]+>/g, "") // strip remaining HTML
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&apos;/g, "'")
        .trim();
    }

    if (userName && comment) {
      comments.push({
        number,
        userName,
        rawDate: rawDate || "unknown",
        createdAt,
        comment,
      });
    }
  }

  return comments;
}

/**
 * Extract the product title from the page's <title> or <h1>
 */
function extractProductTitle(html) {
  // Try <title> first (Jimdo format: "Product Name - DESS Équipement")
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    const full = titleMatch[1].trim();
    // Remove site name suffix
    const cleaned = full.replace(/\s*[-–|]\s*DESS.*$/i, "").trim();
    if (cleaned) return cleaned;
  }

  // Fallback: first <h1> or <h2> in content area
  const h1Match = html.match(/<h[12][^>]*>([^<]+)<\/h[12]>/i);
  return h1Match ? h1Match[1].trim() : null;
}

// --- Progress & Resume ---

function loadProgress() {
  if (RESUME && fs.existsSync(PROGRESS_FILE)) {
    const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
    console.log(`Resuming from index ${progress.lastIndex + 1} (${progress.completedSlugs.length} pages already done)\n`);
    return progress;
  }
  return { lastIndex: -1, completedSlugs: new Set(), results: { products: [] } };
}

function saveProgress(index, results) {
  const progress = {
    lastIndex: index,
    completedSlugs: results.products.map((p) => p.slug),
    results,
  };
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress), "utf-8");
}

// --- Main ---

function main() {
  console.log(`Scraping ${PRODUCT_PATHS.length} product pages from ${BASE_URL}`);
  console.log(`Output: ${OUTPUT_FILE}`);
  if (RESUME) console.log("Mode: RESUME");
  console.log();

  const progress = loadProgress();
  const completedSlugs = new Set(progress.completedSlugs || []);

  const results = {
    scrapedAt: new Date().toISOString(),
    source: BASE_URL,
    totalReviews: 0,
    products: progress.results?.products || [],
  };

  let pagesWithReviews = results.products.length;
  let totalReviews = results.products.reduce((sum, p) => sum + p.reviewCount, 0);
  let failures = 0;
  const startIndex = RESUME ? (progress.lastIndex + 1) : 0;

  for (let i = startIndex; i < PRODUCT_PATHS.length; i++) {
    const pagePath = PRODUCT_PATHS[i];
    const url = `${BASE_URL}${pagePath}`;
    const slug = pagePath.replace(/^\/|\/$/g, "").replace(/\//g, "--");

    if (completedSlugs.has(slug)) {
      continue;
    }

    process.stdout.write(
      `[${i + 1}/${PRODUCT_PATHS.length}] ${slug.padEnd(40)}`,
    );

    try {
      const html = fetchPage(url);
      const productTitle = extractProductTitle(html);
      const comments = parseComments(html);

      if (comments.length > 0) {
        pagesWithReviews++;
        totalReviews += comments.length;
        results.products.push({
          slug,
          url,
          productTitle,
          reviewCount: comments.length,
          reviews: comments,
        });
        console.log(`✓ ${comments.length} reviews (${productTitle})`);
      } else {
        console.log("- no reviews");
      }
    } catch (err) {
      failures++;
      const msg = err.message || String(err);
      console.log(`✗ FAILED: ${msg}`);
    }

    // Save progress after each page (allows resume)
    saveProgress(i, results);

    // Rate limit: 3s between requests to be gentle with Cloudflare
    execSync("sleep 3");
  }

  results.totalReviews = totalReviews;

  // Sort products by slug for consistency
  results.products.sort((a, b) => a.slug.localeCompare(b.slug));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), "utf-8");

  // Clean up progress file on success
  if (fs.existsSync(PROGRESS_FILE)) {
    fs.unlinkSync(PROGRESS_FILE);
  }

  console.log("\n--- Summary ---");
  console.log(`Pages scraped:      ${PRODUCT_PATHS.length}`);
  console.log(`Pages with reviews: ${pagesWithReviews}`);
  console.log(`Total reviews:      ${totalReviews}`);
  console.log(`Failures:           ${failures}`);
  console.log(`Output:             ${OUTPUT_FILE}`);
}

try {
  main();
} catch (err) {
  console.error("Fatal error:", err);
  process.exit(1);
}
