# DynamoDB Setup Scripts - Changes Summary

## Issue
The digital-downloads app couldn't be registered because the required DynamoDB tables didn't exist in the deployed environment. While a setup script existed, tsx wasn't available on the deployed service to run it.

## Solution
Created multiple alternative methods to initialize the database tables without requiring tsx.

## Files Created/Modified

### 1. **New API Endpoint** (Recommended for Deployed Services)
- **File**: `src/app/api/setup-db/route.ts`
- **Purpose**: HTTP endpoint to create tables via POST request
- **Usage**:
  ```bash
  # Create tables
  curl -X POST https://your-app-url/api/setup-db

  # Check if tables exist
  curl -X GET https://your-app-url/api/setup-db
  ```
- **Features**:
  - POST: Creates table if it doesn't exist
  - GET: Checks table status
  - Full error handling and logging
  - Uses same env configuration as the rest of the app

### 2. **Standalone Node.js Script**
- **File**: `scripts/setup-dynamodb-standalone.mjs`
- **Purpose**: Pure JavaScript version that runs with plain Node.js (no tsx needed)
- **Usage**:
  ```bash
  node scripts/setup-dynamodb-standalone.mjs --endpoint-url https://your-dynamodb-url
  # or
  pnpm setup-dynamodb:standalone --endpoint-url https://your-dynamodb-url
  ```
- **Features**:
  - Reads from environment variables
  - Supports custom endpoint via CLI argument
  - Same table creation logic as original script

### 3. **AWS CLI Script**
- **File**: `scripts/setup-dynamodb-aws-cli.sh`
- **Purpose**: Bash script using AWS CLI for environments where it's available
- **Usage**:
  ```bash
  chmod +x scripts/setup-dynamodb-aws-cli.sh
  ./scripts/setup-dynamodb-aws-cli.sh
  ```
- **Features**:
  - Uses standard AWS CLI commands
  - Checks if table exists before creating
  - Configurable via environment variables

### 4. **Updated package.json**
- **Change**: Added new script `setup-dynamodb:standalone`
- **Line 22**:
  ```json
  "setup-dynamodb:standalone": "node --env-file-if-exists=.env ./scripts/setup-dynamodb-standalone.mjs"
  ```

### 5. **Documentation**
- **File**: `SETUP_DB_README.md`
- **Purpose**: Comprehensive guide covering all setup methods
- **Contents**:
  - Problem description
  - 4 different solution approaches
  - Usage examples for each method
  - Environment variable configuration
  - Troubleshooting tips
  - Verification instructions

## Technical Details

### Table Schema
All methods create identical table structure:
- **Table Name**: Configured via `DYNAMODB_MAIN_TABLE_NAME` env variable (default: "digital-downloads-main-table")
- **Partition Key**: `PK` (String, HASH)
- **Sort Key**: `SK` (String, RANGE)
- **Provisioned Throughput**: 5 read units, 5 write units

### Environment Variables Used
- `DYNAMODB_MAIN_TABLE_NAME` - Table name
- `AWS_ENDPOINT_URL` - DynamoDB endpoint (optional, for local/custom endpoints)
- `AWS_REGION` - AWS region
- `AWS_ACCESS_KEY_ID` - AWS access key
- `AWS_SECRET_ACCESS_KEY` - AWS secret key

### Build Compatibility
- ✅ Docker build passes with TypeScript compilation
- ✅ API endpoint compiles with Next.js build
- ✅ Uses proper logging via `@/lib/logger`
- ✅ Follows app's environment variable patterns

## Migration Path

### For Local Development
Continue using the original tsx script:
```bash
pnpm setup-dynamodb --endpoint-url http://localhost:8001
```

### For Deployed Environments
Choose based on available tools:

1. **Best option**: Use the HTTP API endpoint (no shell access needed)
2. **Node.js available**: Use the standalone script
3. **AWS CLI available**: Use the bash script
4. **Shell access with tsx**: Use original script

## Testing

### Build Test
```bash
cd saleor-apps
docker build -f apps/digital-downloads/Dockerfile -t digital-downloads-app:latest .
```
✅ Build successful - all TypeScript compilation passes

### Runtime Test
After deployment:
1. Call `/api/setup-db` endpoint
2. Verify table creation in DynamoDB
3. Attempt to register the app in Saleor Dashboard

## Notes

- The API endpoint should have authentication added before production use
- All methods are idempotent (safe to run multiple times)
- Scripts check for table existence before attempting creation
- Consistent error handling and logging across all methods
