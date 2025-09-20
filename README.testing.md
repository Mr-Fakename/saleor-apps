# Saleor Apps - Standalone Testing Guide

This guide explains how to use the refactored Docker setup for independent testing without CLI arguments.

## Quick Start - Standalone Testing

### Option 1: Runtime App Selection (Recommended for Testing)

```bash
# Build once, run any app
docker build -t saleor-apps .

# Run different apps by setting APP_NAME environment variable
docker run -e APP_NAME=stripe -p 3000:3000 saleor-apps
docker run -e APP_NAME=cms -p 3000:3000 saleor-apps  
docker run -e APP_NAME=klaviyo -p 3000:3000 saleor-apps
```

### Option 2: Docker Compose (Best for IDE Integration)

```bash
# Run any app dynamically
APP_NAME=stripe docker-compose up any-app
APP_NAME=cms docker-compose up any-app
APP_NAME=search docker-compose up any-app

# Run with DynamoDB for full testing
APP_NAME=stripe docker-compose up any-app dynamodb-local

# Development mode with hot reload
APP_NAME=avatax docker-compose up dev dynamodb-local
```

### Option 3: All-in-One Test Runner

```bash
# Test runner with pre-configured testing environment
APP_NAME=stripe docker-compose up test-runner dynamodb-local
```

## Available Apps

- `stripe` - Payment processing
- `cms` - Content management
- `klaviyo` - Email marketing
- `search` - Product search
- `segment` - Analytics
- `smtp` - Email delivery
- `avatax` - Tax calculation
- `np-atobarai` - Japanese payments
- `products-feed` - Product feeds

## IDE Integration

### VS Code with Docker Extension

1. **Build the image:**
   ```bash
   docker build -t saleor-apps .
   ```

2. **Create run configuration:**
   - Image: `saleor-apps`
   - Environment Variables: `APP_NAME=stripe`
   - Ports: `3000:3000`
   - Networks: Connect to `saleor-apps` network if using DynamoDB

3. **For debugging:**
   - Add environment variable: `NODE_OPTIONS=--inspect=0.0.0.0:9229`
   - Add port mapping: `9229:9229`

### IntelliJ/WebStorm Docker Integration

1. **Create Docker Run Configuration:**
   - Image: `saleor-apps`
   - Container name: `saleor-app-test`
   - Environment variables:
     ```
     APP_NAME=stripe
     NODE_ENV=production
     PORT=3000
     ```
   - Port bindings: `3000:3000`

2. **For development debugging:**
   - Use docker-compose integration
   - Run: `APP_NAME=stripe docker-compose up dev`
   - Attach debugger to port 9229

## Testing Scenarios

### 1. Basic App Testing

```bash
# Test if app starts correctly
docker run --rm -e APP_NAME=stripe -p 3000:3000 saleor-apps

# Check health endpoint
curl http://localhost:3000/api/health
```

### 2. Integration Testing with DynamoDB

```bash
# Start DynamoDB and app
docker-compose up dynamodb-local any-app

# Set specific app
APP_NAME=cms docker-compose up dynamodb-local any-app
```

### 3. Multi-App Testing

```bash
# Test multiple apps simultaneously (different ports)
APP_NAME=stripe docker-compose up any-app &
APP_NAME=cms docker-compose -f docker-compose.yml up cms &
```

### 4. Development Testing

```bash
# Hot reload development
APP_NAME=search docker-compose up dev dynamodb-local

# Development with specific port
APP_NAME=avatax docker-compose up dev
```

## Configuration

### Environment Files

Create app-specific environment files:

- `.env.stripe` - Stripe app configuration
- `.env.cms` - CMS app configuration
- `.env.example` - Template with all possible variables

Example `.env.stripe`:
```bash
APP_NAME=stripe
SALEOR_API_URL=http://localhost:8000/graphql/
STRIPE_SECRET_KEY=sk_test_...
DYNAMODB_MAIN_TABLE_NAME=saleor-apps-config
```

### Docker Environment Variables

Key variables for runtime configuration:

- `APP_NAME` - Which app to run (required)
- `NODE_ENV` - Environment mode (development/production)
- `PORT` - App port (default: 3000)
- `AWS_ENDPOINT_URL` - DynamoDB endpoint for local testing

## Benefits of This Approach

1. **No CLI Arguments Required** - Apps can be run without build-time arguments
2. **IDE Friendly** - Easy to configure in any IDE with Docker support  
3. **Runtime Flexibility** - Switch between apps without rebuilding
4. **Testing Optimized** - Pre-configured testing environments
5. **Development Ready** - Hot reload support for development
6. **CI/CD Compatible** - Works with automated testing pipelines

## Troubleshooting

### App Not Starting

```bash
# Check if app name is valid
docker run --rm saleor-apps ls -1 /app/apps/

# Check logs for specific app
docker logs [container-name]

# Test with minimal environment
docker run --rm -e APP_NAME=stripe -e NODE_ENV=development saleor-apps
```

### Port Conflicts

```bash
# Use different port mapping
docker run -e APP_NAME=stripe -p 3001:3000 saleor-apps

# Or modify docker-compose port
APP_NAME=cms docker-compose up any-app  # Uses port 3005
```

### Environment Issues

```bash
# Verify environment loading
docker run --rm -e APP_NAME=stripe saleor-apps env | grep APP_

# Test with explicit environment file
docker run --rm --env-file .env.stripe saleor-apps
```

### DynamoDB Connection Issues

```bash
# Ensure DynamoDB is running
docker-compose up dynamodb-local

# Test DynamoDB connectivity
curl http://localhost:8000/

# Check network connectivity
docker run --rm --network saleor-apps_default curlimages/curl curl http://dynamodb-local:8000/
```

## Integration with CI/CD

### GitHub Actions Example

```yaml
name: Test Saleor Apps
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        app: [stripe, cms, klaviyo, search]
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Build Test Image
        run: docker build -t saleor-apps .
      
      - name: Test ${{ matrix.app }}
        run: |
          docker run -d --name test-${{ matrix.app }} \
            -e APP_NAME=${{ matrix.app }} \
            -p 3000:3000 \
            saleor-apps
          
          # Wait for app to start
          sleep 10
          
          # Test health endpoint
          curl --fail http://localhost:3000/api/health
          
          # Cleanup
          docker stop test-${{ matrix.app }}
```

This refactored setup provides maximum flexibility for testing individual Saleor apps without requiring CLI arguments, making it perfect for IDE integration and automated testing scenarios.