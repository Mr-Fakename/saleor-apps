# Saleor Digital Downloads App

A complete Saleor app for managing digital file downloads with secure, time-limited tokens.

## Features

- Automatic token generation when orders are fully paid
- Secure HMAC-SHA256 signed download tokens
- Time-limited access (default: 72 hours)
- Download count tracking and limits (default: 5 downloads)
- DynamoDB storage for scalability
- Full observability with logging and error tracking

## Architecture

### Core Components

1. **Download Token Domain** (`src/modules/download-tokens/`)
   - Domain model with Zod validation
   - Repository pattern for data access
   - DynamoDB implementation with dynamodb-toolbox

2. **Token Generator** (`src/modules/token-generator/`)
   - HMAC-SHA256 token generation
   - Cryptographic signature verification
   - Token payload parsing

3. **ORDER_FULLY_PAID Webhook** (`src/app/api/webhooks/saleor/order-fully-paid/`)
   - Processes fully paid orders
   - Identifies digital products by media attachments
   - Generates download tokens for each digital item
   - Stores tokens in DynamoDB

4. **Download API** (`src/app/api/downloads/[token]/`)
   - Validates token signatures
   - Checks expiry dates
   - Enforces download limits
   - Tracks download attempts
   - Redirects to file URLs

## Setup

### 1. Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Required
SECRET_KEY=your-secret-key-here  # Generate with: openssl rand -hex 32
ALLOWED_DOMAIN_PATTERN=/*/

# DynamoDB (local development)
AWS_REGION=localhost
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=local
AWS_ENDPOINT_URL=http://localhost:8000
DYNAMODB_MAIN_TABLE_NAME=digital-downloads-main-table

# Optional - Token Configuration
DOWNLOAD_TOKEN_EXPIRY_HOURS=72  # Default: 72 hours (3 days)
MAX_DOWNLOAD_LIMIT=5            # Default: 5 downloads
```

### 2. Setup DynamoDB

For local development:

```bash
# Start local DynamoDB (using Docker)
docker run -d -p 8000:8000 amazon/dynamodb-local

# Create tables
pnpm tsx scripts/setup-dynamodb.ts
```

For production, set AWS credentials and update `AWS_ENDPOINT_URL`.

### 3. Generate GraphQL Types

```bash
pnpm run generate
```

### 4. Run the App

```bash
pnpm dev
```

## How It Works

### 1. Order Completion Flow

```
Order Paid → ORDER_FULLY_PAID webhook → Check for digital products
    ↓
Identify products with media files
    ↓
For each digital product:
    - Generate secure token
    - Set expiry (72 hours)
    - Set download limit (5)
    - Store in DynamoDB
    ↓
Customer receives order confirmation (implement notification)
```

### 2. Download Flow

```
Customer clicks download link → /api/downloads/{token}
    ↓
Verify token signature
    ↓
Check token exists in database
    ↓
Validate expiry date
    ↓
Check download count < limit
    ↓
Increment download count
    ↓
Redirect to file URL
```

### 3. Token Format

Tokens use the format: `base64(payload).hmac_signature`

**Payload**: `orderId:fileUrl:expiresAt`

**Example**:
```
base64("order_123:https://cdn.example.com/file.pdf:2025-10-11T12:00:00Z")
.
a3f5e8d9c2b1a0f3e5d8c9b2a1f0e3d5c8b9a2f1e0d3c5b8a9f2e1d0c3b5a8f9
```

## Digital Product Configuration

The app identifies digital products by checking for media attachments:

1. **Variant Media**: Attached directly to the product variant
2. **Product Media**: Attached to the parent product

To make a product downloadable:
1. In Saleor Dashboard, go to the product
2. Upload digital files to the product or variant media
3. The first media item's URL will be used as the download link

## Database Schema

### Download Token Record

```typescript
{
  PK: "TOKEN#{token}",           // Partition key
  SK: "METADATA",                 // Sort key
  token: string,                  // Full token string
  orderId: string,                // Saleor order ID
  orderNumber: string,            // Human-readable order number
  customerId?: string,            // Customer ID (optional)
  customerEmail?: string,         // Customer email (optional)
  fileUrl: string,                // URL to the digital file
  productName: string,            // Product name
  variantName?: string,           // Variant name (optional)
  expiresAt: string,              // ISO datetime
  maxDownloads: number,           // Max allowed downloads
  downloadCount: number,          // Current download count
  createdAt: string,              // ISO datetime
  lastAccessedAt?: string         // Last download timestamp
}
```

## API Endpoints

### Download Endpoint

**GET** `/api/downloads/{token}`

**Responses:**
- `302 Redirect` - Success, redirects to file
- `401 Unauthorized` - Invalid or malformed token
- `403 Forbidden` - Download limit exceeded
- `404 Not Found` - Token doesn't exist
- `410 Gone` - Token has expired
- `500 Internal Server Error` - Server error

**Example:**
```bash
curl -L "https://your-app.com/api/downloads/abc123.signature"
```

## Integration with Your Storefront

After implementing this app, you'll need to:

1. **Add notification system** to email customers their download links
2. **Display download links** in order confirmation pages
3. **Show download status** (remaining downloads, expiry time)

Example storefront code:

```typescript
// In your order confirmation page
const downloadLink = `${process.env.NEXT_PUBLIC_APP_URL}/api/downloads/${token}`;

return (
  <a href={downloadLink} download>
    Download {productName}
  </a>
);
```

## Error Handling

The app uses Result types (neverthrow) for type-safe error handling:

```typescript
const result = await downloadTokenRepo.getByToken(token);

if (result.isErr()) {
  // Handle error
  logger.error("Failed to fetch token", { error: result.error });
  return;
}

// Success
const token = result.value;
```

## Logging and Monitoring

All operations are logged with structured logging:

```typescript
logger.info("Download authorized", {
  token: tokenParam,
  fileUrl: token.fileUrl,
  downloadCount: token.downloadCount + 1,
  productName: token.productName,
});
```

Errors are automatically sent to Sentry when configured.

## Security Considerations

1. **Token Signing**: All tokens are signed with HMAC-SHA256
2. **Timing-Safe Comparison**: Uses `crypto.timingSafeEqual()` to prevent timing attacks
3. **Expiry Enforcement**: Tokens automatically expire after configured hours
4. **Download Limits**: Prevents abuse with configurable download limits
5. **Secret Key**: Store `SECRET_KEY` securely (use environment variables)

## Testing

### Unit Tests
```bash
pnpm test
```

### Manual Testing

1. Create a test product with media attachment
2. Complete a test order
3. Check DynamoDB for generated tokens
4. Test download endpoint with valid/invalid tokens

## Troubleshooting

### No tokens generated after order payment
- Check that products have media attachments
- Verify webhook is registered: `pnpm run webhooks:sync`
- Check logs for errors in ORDER_FULLY_PAID webhook

### Token validation fails
- Verify `SECRET_KEY` matches between token generation and validation
- Check token hasn't expired
- Ensure download limit not exceeded

### DynamoDB connection issues
- Verify AWS credentials
- Check `AWS_ENDPOINT_URL` is correct
- Ensure DynamoDB table exists

## Production Deployment

1. **Set up production DynamoDB table** in AWS
2. **Configure AWS credentials** via environment variables
3. **Set proper SECRET_KEY** (never use development keys)
4. **Enable HTTPS** for security
5. **Configure CDN** for file hosting
6. **Set up monitoring** via Sentry
7. **Configure backups** for DynamoDB

## Future Enhancements

- [ ] Email notifications with download links
- [ ] Customer download history dashboard
- [ ] Admin panel for token management
- [ ] File streaming instead of redirect
- [ ] S3 signed URL generation
- [ ] Multi-file downloads (ZIP)
- [ ] Download analytics
- [ ] Custom expiry per product
- [ ] Watermarking for PDFs/images

## License

Same as parent Saleor Apps repository.
