# Legacy Review Import

Import reviews from the old Jimdo site (dess-equipement.com) into the Saleor customer-extensions DynamoDB review system.

## Status

- **Phase 1 (scraping): DONE** — 149 reviews scraped from 40 products (2026-03-03)
- **Phase 2 (mapping): DONE** — all 40 legacy products mapped to Saleor product IDs (2026-03-04)
- **Phase 3 (import): READY** — run dry-run then `--execute` (see steps below)

## Files

| File | Purpose |
|---|---|
| `legacy-reviews.json` | Scraped review data (149 reviews, 40 products) |
| `product-mapping.json` | Product slug → Saleor product ID mapping (filled, 40/40 mapped) |
| `scrape-legacy-reviews.mjs` | Scraper script (curl-based, Cloudflare-safe, resumable) |
| `import-legacy-reviews.mjs` | DynamoDB import script (dry-run by default, idempotent) |

## Phase 2: Import Steps

### 1. Fill in product mapping

Edit `product-mapping.json` — replace every `"TODO_SALEOR_PRODUCT_ID"` with the actual Saleor product ID (base64-encoded, e.g. `"UHJvZHVjdDoxMjM="`).

Products without a mapping will be skipped during import. You can fill in mappings incrementally as products are added to Saleor.

Helper fields `_url` and `_reviewCount` are for reference — remove them when done or leave them (the import script ignores them).

### 2. Re-scrape (optional)

If new reviews have been posted since the initial scrape (2026-03-03), re-run the scraper:

```bash
cd saleor-apps/apps/customer-extensions/scripts/import-legacy-reviews
node scrape-legacy-reviews.mjs
```

If interrupted, resume with `--resume`. The scraper uses curl with 3s rate limiting to avoid Cloudflare blocks.

### 3. Dry run

Preview what would be written to DynamoDB:

```bash
cd saleor-apps/apps/customer-extensions/scripts/import-legacy-reviews
DYNAMODB_MAIN_TABLE_NAME=your-table-name \
AWS_REGION=eu-west-1 \
node import-legacy-reviews.mjs
```

This prints every review with its DynamoDB PK/SK and truncated content — no writes are made.

### 4. Execute

```bash
DYNAMODB_MAIN_TABLE_NAME=your-table-name \
AWS_REGION=eu-west-1 \
node import-legacy-reviews.mjs --execute
```

### 5. Regenerate mapping template (if re-scraped)

If you re-scraped and got new products with reviews:

```bash
node import-legacy-reviews.mjs --generate-mapping
```

This overwrites `product-mapping.json` with a fresh template. Back up your filled-in mappings first.

## How Legacy Reviews Are Stored

| Field | Value | Notes |
|---|---|---|
| `userId` | `LEGACY_USER_{hash}` | Deterministic hash of slug+name+date |
| `orderId` | `LEGACY_ORDER_{hash}` | Same hash strategy |
| `userEmail` | `legacy-import@placeholder.local` | Placeholder |
| `userName` | Original name (e.g. "Florian") | From scraped data |
| `rating` | `5` | Default — old site had no ratings |
| `comment` | Full review text | HTML entities decoded, newlines preserved |
| `verifiedPurchase` | `"false"` | Distinguishes from real verified reviews |
| `status` | `"approved"` | Immediately visible |
| `createdAt` | Original date (ISO) | Parsed from French dates |

The import is **idempotent** — same inputs produce the same deterministic IDs, so re-running overwrites with identical data rather than creating duplicates.

## Frontend Considerations

When displaying reviews, use `verifiedPurchase` to differentiate:
- `"true"` → show "Verified Purchase" badge
- `"false"` → show no badge (or "Legacy Review" label if desired)

Legacy reviews use `LEGACY_USER_*` as userId, which won't match any real Saleor user — handle gracefully in user lookup code.

## Data Quality Notes

- 147/149 dates parsed to ISO timestamps
- 2 reviews from user "cnx apocalyps" (2018-04-17) are missing time — stored with `createdAt: null`, import script uses current time as fallback
- All text is HTML-decoded (entities → characters) with `<br>` → newlines
