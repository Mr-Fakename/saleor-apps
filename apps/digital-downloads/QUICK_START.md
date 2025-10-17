# Digital Downloads App - Quick Start Guide

## 🚀 Getting Started in 5 Minutes

### 1. Install Dependencies (if needed)

```bash
cd saleor-apps/apps/digital-downloads
pnpm install
```

### 2. Configure Environment

```bash
# Copy example env file
cp .env.example .env

# Generate a secret key
openssl rand -hex 32

# Edit .env and add your secret key
nano .env
```

Required in `.env`:
```env
SECRET_KEY=your-generated-secret-key-here
DYNAMODB_MAIN_TABLE_NAME=digital-downloads-main-table
AWS_REGION=localhost
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=local
```

### 3. Start Local DynamoDB

```bash
# Using Docker
docker run -d -p 8000:8000 amazon/dynamodb-local
```

### 4. Create DynamoDB Table

```bash
pnpm run setup-dynamodb
```

You should see:
```
Starting DynamoDB setup with endpoint: http://localhost:8000
Table digital-downloads-main-table created successfully
DynamoDB setup completed successfully
```

### 5. Generate GraphQL Types

```bash
pnpm run generate
```

This generates TypeScript types from your GraphQL queries/subscriptions.

### 6. Start Development Server

```bash
pnpm dev
```

App will run on `http://localhost:3000`

### 7. Install App in Saleor

1. Go to your Saleor Dashboard → Apps → Install external app
2. Enter manifest URL: `http://localhost:3000/api/manifest`
3. Confirm permissions
4. App is now installed!

### 8. Test the Flow

#### Create a Digital Product:

1. **In Saleor Dashboard**:
   - Go to Products → Add Product
   - Name: "Digital eBook"
   - Add variant
   - **Important**: Upload a file to Product Media or Variant Media
   - Set price
   - Publish

2. **Create Test Order**:
   - Go to Storefront (or use GraphQL)
   - Add product to cart
   - Complete checkout
   - Mark order as paid

3. **Check Logs**:
   ```bash
   # In your terminal where app is running
   # You should see:
   [ORDER_FULLY_PAID] Processing order...
   [OrderFullyPaidUseCase] Download token created successfully
   ```

4. **Verify Token in DynamoDB**:
   ```bash
   # Install AWS CLI or use DynamoDB GUI
   aws dynamodb scan \
     --table-name digital-downloads-main-table \
     --endpoint-url http://localhost:8000 \
     --region localhost
   ```

5. **Test Download**:
   ```bash
   # Get the token from logs or DynamoDB
   curl -L "http://localhost:3000/api/downloads/{YOUR_TOKEN_HERE}"

   # Should redirect to your file URL
   ```

## 📝 Common Commands

```bash
# Development
pnpm dev              # Start dev server
pnpm dev:debug        # Start with debugging

# Building
pnpm build            # Build for production
pnpm start            # Start production server

# Code Quality
pnpm lint             # Lint code
pnpm lint:fix         # Fix lint issues
pnpm check-types      # TypeScript type checking

# GraphQL
pnpm generate         # Generate GraphQL types
pnpm fetch-schema     # Fetch latest Saleor schema

# Database
pnpm setup-dynamodb   # Create DynamoDB tables

# Testing
pnpm test             # Run unit tests
pnpm test:ci          # Run tests with coverage
pnpm test:e2e         # Run E2E tests (not implemented yet)
```

## 🔍 Debugging

### Check if webhook is registered:

```graphql
query {
  app(id: "your-app-id") {
    webhooks {
      name
      targetUrl
      isActive
    }
  }
}
```

Look for "Digital Downloads Order Fully Paid" webhook.

### View logs:

```bash
# Terminal where pnpm dev is running shows all logs
# Look for:
[ORDER_FULLY_PAID route] Received webhook request
[OrderFullyPaidUseCase] Processing ORDER_FULLY_PAID webhook
[DynamoDBDownloadTokenRepo] Saving download token
```

### Test token validation:

```bash
# Invalid token
curl "http://localhost:3000/api/downloads/invalid-token"
# Should return: {"error": "Invalid or malformed token"} with 401

# Valid but non-existent token
curl "http://localhost:3000/api/downloads/dGVzdA==.abc123"
# Should return: {"error": "Token not found"} with 404
```

## 🛠️ Troubleshooting

### Issue: "Table already exists"
```bash
# DynamoDB table already created, just continue
pnpm dev
```

### Issue: "SECRET_KEY is required"
```bash
# Generate a new secret key
openssl rand -hex 32

# Add to .env file
echo "SECRET_KEY=your-generated-key" >> .env
```

### Issue: "Cannot connect to DynamoDB"
```bash
# Check if DynamoDB is running
docker ps | grep dynamodb

# If not running, start it
docker run -d -p 8000:8000 amazon/dynamodb-local

# Verify connection
curl http://localhost:8000
```

### Issue: "No tokens generated after order payment"
1. Check product has media attachments (variant or product media)
2. Check webhook is registered and active
3. Check logs for errors
4. Verify order status is "FULLY_PAID"

### Issue: "Token validation fails"
1. Verify SECRET_KEY in .env matches the one used to generate token
2. Check token hasn't expired (72 hours default)
3. Check download limit not exceeded (5 downloads default)
4. Check logs for specific error

## 📚 Next Steps

1. **Implement Notifications**: Send download links to customers via email
2. **Add Admin UI**: Build interface to view and manage tokens
3. **Configure File Storage**: Set up S3 or CDN for file hosting
4. **Production Setup**: Deploy to Vercel/AWS with production DynamoDB
5. **Security Audit**: Review and test security measures
6. **Add Tests**: Write unit and integration tests

## 📖 Documentation

- **Full Documentation**: See `DIGITAL_DOWNLOADS_README.md`
- **Implementation Details**: See `IMPLEMENTATION_SUMMARY.md`
- **Saleor Apps Guide**: See `../../CLAUDE.md`

## 🆘 Need Help?

1. Check logs in terminal where app is running
2. Review `DIGITAL_DOWNLOADS_README.md` for detailed docs
3. Check Saleor documentation: https://docs.saleor.io/
4. Review stripe app implementation for similar patterns

## ✅ Checklist

- [ ] Dependencies installed (`pnpm install`)
- [ ] `.env` file created with SECRET_KEY
- [ ] Local DynamoDB running
- [ ] DynamoDB table created (`pnpm setup-dynamodb`)
- [ ] GraphQL types generated (`pnpm generate`)
- [ ] App running (`pnpm dev`)
- [ ] App installed in Saleor Dashboard
- [ ] Test product created with media
- [ ] Test order completed and paid
- [ ] Token generated (check logs)
- [ ] Download link works

---

**You're all set!** 🎉

The Digital Downloads app is now ready to generate secure download tokens for your digital products.
