# DynamoDB Setup for Digital Downloads App

This document provides multiple solutions for setting up the required DynamoDB tables for the digital-downloads app, especially when tsx is not available on the deployed service.

## Problem

The app requires DynamoDB tables to be created before it can register and work properly. The error you may see:

```
DynamoDBLocalServiceException: Cannot do operations on a non-existent table
software.amazon.dynamodb.services.exceptions.DynamoDBLocalServiceException: Cannot do operations on a non-existent table
```

This happens because the database tables weren't created on your deployed DynamoDB instance before the app tried to use them.

## Solutions

### Option 1: HTTP API Endpoint (Easiest for Deployed Services)

The app now includes an API endpoint that can initialize the database.

**Usage:**

1. Make sure your app is deployed and running with proper environment variables
2. Call the setup endpoint:

```bash
# Create the tables
curl -X POST https://your-app-url.com/api/setup-db

# Check if tables exist
curl -X GET https://your-app-url.com/api/setup-db
```

**Security Note:** Consider adding authentication to this endpoint before using in production. You can modify `src/app/api/setup-db/route.ts` to add authorization checks.

### Option 2: Standalone Node.js Script

A standalone JavaScript file that can run with plain Node.js (no tsx required).

**Usage:**

```bash
cd saleor-apps/apps/digital-downloads

# For deployed DynamoDB
node --env-file-if-exists=.env ./scripts/setup-dynamodb-standalone.mjs --endpoint-url https://your-dynamodb-url

# Or use the npm script
pnpm setup-dynamodb:standalone --endpoint-url https://your-dynamodb-url

# For local development
pnpm setup-dynamodb:standalone --endpoint-url http://localhost:8001
```

**Environment Variables:**

The script reads from these environment variables:
- `DYNAMODB_MAIN_TABLE_NAME` - Table name (default: "digital-downloads-main-table")
- `AWS_ENDPOINT_URL` - DynamoDB endpoint (default: "http://localhost:8001")
- `AWS_REGION` - AWS region (default: "localhost")
- `AWS_ACCESS_KEY_ID` - AWS access key (default: "local")
- `AWS_SECRET_ACCESS_KEY` - AWS secret key (default: "local")

### Option 3: AWS CLI

If you have AWS CLI installed on your server, you can use a shell script.

**Usage:**

```bash
cd saleor-apps/apps/digital-downloads

# Make the script executable (Linux/Mac)
chmod +x ./scripts/setup-dynamodb-aws-cli.sh

# Run it
./scripts/setup-dynamodb-aws-cli.sh

# Or with custom endpoint
ENDPOINT_URL=https://your-dynamodb-url ./scripts/setup-dynamodb-aws-cli.sh
```

**For Windows PowerShell:**

```powershell
$env:DYNAMODB_MAIN_TABLE_NAME="digital-downloads-main-table"
$env:AWS_ENDPOINT_URL="your-dynamodb-url"
$env:AWS_REGION="localhost"

aws dynamodb create-table `
    --table-name $env:DYNAMODB_MAIN_TABLE_NAME `
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S `
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE `
    --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5 `
    --endpoint-url $env:AWS_ENDPOINT_URL `
    --region $env:AWS_REGION
```

### Option 4: Original TypeScript Script (Local Development)

The original tsx-based script works well for local development.

**Usage:**

```bash
cd saleor-apps/apps/digital-downloads
pnpm setup-dynamodb --endpoint-url http://localhost:8001
```

## Table Schema

All methods create the same table:

- **Table Name:** `digital-downloads-main-table` (configurable via env)
- **Partition Key (PK):** String (HASH)
- **Sort Key (SK):** String (RANGE)
- **Provisioned Throughput:** 5 read/write capacity units

## Verification

After running any of the above methods, you can verify the table was created:

**Using the API endpoint:**
```bash
curl https://your-app-url.com/api/setup-db
```

**Using AWS CLI:**
```bash
aws dynamodb describe-table \
    --table-name digital-downloads-main-table \
    --endpoint-url your-dynamodb-url \
    --region localhost
```

## Troubleshooting

1. **Connection refused:** Check that your DynamoDB endpoint URL is correct
2. **Authentication errors:** Verify AWS credentials in environment variables
3. **Table already exists:** This is fine! The scripts will skip creation
4. **Permission denied:** Ensure the AWS credentials have DynamoDB table creation permissions

## Files Created

- `scripts/setup-dynamodb-standalone.mjs` - Node.js script (no tsx needed)
- `scripts/setup-dynamodb-aws-cli.sh` - Bash script using AWS CLI
- `src/app/api/setup-db/route.ts` - HTTP API endpoint for setup
- Package.json now includes `setup-dynamodb:standalone` script
