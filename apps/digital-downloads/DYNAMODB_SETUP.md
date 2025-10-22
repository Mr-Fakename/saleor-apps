# DynamoDB Table Initialization Guide

This document explains how to initialize DynamoDB tables for the Digital Downloads App in different environments.

## Problem

The Digital Downloads app requires DynamoDB tables to be created before it can function properly. The original setup script (`scripts/setup-dynamodb.ts`) uses `tsx` to run TypeScript directly, which is not available in production Docker containers.

## Solutions

We provide **three methods** for initializing DynamoDB tables, depending on your deployment scenario:

---

## Option 1: Automatic Initialization on Startup ⭐ **RECOMMENDED FOR PRODUCTION**

The app automatically creates required DynamoDB tables when it starts up. This is the most convenient option for production deployments.

### How It Works

- The app checks for tables during startup via Next.js instrumentation hooks
- If tables don't exist, they are created automatically
- If tables already exist, creation is skipped
- The app continues to start even if table creation fails (preventing deployment failures due to temporary AWS issues)

### Setup

1. Set the environment variable in your deployment:
   ```bash
   INIT_DYNAMODB_ON_STARTUP=true
   ```

2. Ensure AWS credentials are properly configured:
   ```bash
   AWS_REGION=us-east-1                    # Your AWS region
   AWS_ACCESS_KEY_ID=your-access-key       # Your AWS access key
   AWS_SECRET_ACCESS_KEY=your-secret-key   # Your AWS secret key
   DYNAMODB_MAIN_TABLE_NAME=digital-downloads-main-table
   ```

3. Deploy the app normally. Tables will be created on first startup.

### When to Use

- ✅ Production deployments (Dokploy, Docker, Kubernetes, etc.)
- ✅ Automated CI/CD pipelines
- ✅ Container orchestration environments
- ✅ Serverless deployments (Vercel, AWS Lambda)

### Advantages

- Zero manual intervention required
- Works in restricted environments (no shell access needed)
- Tables are created before any database operations
- Graceful handling of existing tables (idempotent)
- No external dependencies (tsx, scripts, etc.)

---

## Option 2: Manual Initialization with Node.js Script

Run a plain JavaScript script manually to create tables. This works in any environment with Node.js, including production Docker containers.

### How to Run

**In Docker/Dokploy:**
```bash
cd /app/apps/digital-downloads
node scripts/setup-dynamodb.js
```

**Locally with npm:**
```bash
npm run setup-dynamodb:prod
```

**For local DynamoDB (with custom endpoint):**
```bash
node scripts/setup-dynamodb.js --endpoint-url http://localhost:8001
```

### When to Use

- ✅ Manual setup before deployment
- ✅ Troubleshooting table creation issues
- ✅ Running in Docker exec sessions
- ✅ Custom deployment scripts

### Advantages

- Full control over when tables are created
- Easy to run from shell/SSH sessions
- Works in production containers (no devDependencies needed)
- Provides detailed logging output

---

## Option 3: Development TypeScript Script

For local development only. Uses `tsx` to run the TypeScript version directly.

### How to Run

```bash
npm run setup-dynamodb
```

Or for local DynamoDB with custom endpoint:
```bash
npm run setup-dynamodb -- --endpoint-url http://localhost:8001
```

**Alternative**: Use the standalone .mjs script (also for development):
```bash
npm run setup-dynamodb:standalone
```

### When to Use

- ✅ Local development only
- ✅ When you have all devDependencies installed
- ⚠️ **NOT available in production containers**

### Advantages

- Native TypeScript support
- Full IDE integration and type checking
- Easy to modify and extend

---

## Environment Variables Reference

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `DYNAMODB_MAIN_TABLE_NAME` | Yes | Name of the main DynamoDB table | `digital-downloads-main-table` |
| `AWS_REGION` | Yes | AWS region for DynamoDB | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | Yes* | AWS access key | `AKIAIOSFODNN7EXAMPLE` |
| `AWS_SECRET_ACCESS_KEY` | Yes* | AWS secret key | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| `INIT_DYNAMODB_ON_STARTUP` | No | Enable auto-initialization | `true` or `false` |
| `AWS_ENDPOINT_URL` | No | Custom endpoint for local DynamoDB | `http://localhost:8001` |

\* Not required for local development with DynamoDB Local

---

## Table Schema

All methods create the same table with the following schema:

```javascript
{
  TableName: process.env.DYNAMODB_MAIN_TABLE_NAME,
  AttributeDefinitions: [
    { AttributeName: "PK", AttributeType: "S" },  // Partition Key (String)
    { AttributeName: "SK", AttributeType: "S" },  // Sort Key (String)
  ],
  KeySchema: [
    { AttributeName: "PK", KeyType: "HASH" },     // Partition Key
    { AttributeName: "SK", KeyType: "RANGE" },    // Sort Key
  ],
  ProvisionedThroughput: {
    ReadCapacityUnits: 5,
    WriteCapacityUnits: 5,
  },
}
```

This single-table design pattern allows storing multiple entity types (app configs, download tokens, order metadata) in one table.

---

## Troubleshooting

### "Table already exists" error

This is not actually an error! All methods check if the table exists first and skip creation if it does. You'll see a message like:
```
✓ Table digital-downloads-main-table already exists - skipping creation
```

### Permission errors

Ensure your AWS credentials have the following permissions:
- `dynamodb:DescribeTable`
- `dynamodb:CreateTable`

### Container doesn't have the script

If running Option 2 fails with "file not found", rebuild your Docker image. The `setup-dynamodb.js` file is copied during the build process.

### App crashes on startup

If using Option 1, check the application logs for DynamoDB initialization errors. The app will log the issue but continue starting to prevent deployment failures.

---

## Recommendations by Environment

| Environment | Recommended Method | Notes |
|-------------|-------------------|-------|
| **Dokploy** | Option 1 (Auto) | Set `INIT_DYNAMODB_ON_STARTUP=true` in environment variables |
| **Docker Compose** | Option 2 (Manual) or 1 | Run script in `docker compose exec` or enable auto-init |
| **Kubernetes** | Option 1 (Auto) | Use init container or enable auto-initialization |
| **AWS ECS/Fargate** | Option 1 (Auto) | Best for automated deployments |
| **Vercel** | Option 1 (Auto) | Only option that works with Vercel's build process |
| **Local Development** | Option 3 (TypeScript) | Fastest for development workflow |

---

## Migration Guide

If you were previously running `npm run setup-dynamodb` in production and it was failing:

1. **Quick Fix**: Enable automatic initialization
   ```bash
   # Add this to your deployment environment variables
   INIT_DYNAMODB_ON_STARTUP=true
   ```

2. **Manual Alternative**: Run the Node.js script once
   ```bash
   # SSH into your container
   cd /app/apps/digital-downloads
   node scripts/setup-dynamodb.js
   ```

3. **Rebuild** (if using manual script): Make sure your Docker image includes the latest changes
   ```bash
   docker build -f apps/digital-downloads/Dockerfile -t your-registry/digital-downloads-app:latest .
   ```

---

## Files Created/Modified

This solution includes the following changes:

1. **New Files:**
   - `scripts/setup-dynamodb.js` - Plain JS version of setup script
   - `src/instrumentation.ts` - Next.js instrumentation hooks
   - `src/instrumentations/dynamodb-init.ts` - Automatic initialization module
   - `DYNAMODB_SETUP.md` - This documentation

2. **Modified Files:**
   - `package.json` - Added `setup-dynamodb:prod` script
   - `Dockerfile` - Copies JS script to runtime container
   - `.env.example` - Documents `INIT_DYNAMODB_ON_STARTUP` variable

---

## App-Specific Notes for Digital Downloads

The Digital Downloads app uses DynamoDB to store:
- **Download Tokens**: Generated for each digital product order
- **Token Metadata**: Expiry times, download counts, order associations
- **App Configuration**: Settings for token expiry, download limits, etc.

All these entities are stored in a single DynamoDB table using the single-table design pattern with composite keys (PK/SK).

---

## Further Reading

- [Next.js Instrumentation](https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation)
- [DynamoDB Single-Table Design](https://aws.amazon.com/blogs/compute/creating-a-single-table-design-with-amazon-dynamodb/)
- [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/)
- [Digital Downloads App Documentation](./README.md)
