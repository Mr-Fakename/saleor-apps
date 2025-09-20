# Docker Deployment Guide for Saleor Apps

This guide explains how to deploy individual Saleor apps from the monorepo while maintaining the project structure and git synchronization benefits.

## Quick Start

### Build and Run Single App

```bash
# Build the Stripe app
docker build --build-arg APP_NAME=stripe -t saleor-app-stripe .

# Run the Stripe app
docker run -p 3000:3000 --env-file .env.stripe saleor-app-stripe
```

### Using Docker Compose

```bash
# Run Stripe app
docker-compose up stripe

# Run multiple apps
docker-compose up stripe cms klaviyo

# Development mode with hot reload
APP_NAME=stripe docker-compose up dev
```

### Using Build Script

```bash
# Make script executable (Unix systems)
chmod +x scripts/build-app.sh

# Build Stripe app
./scripts/build-app.sh stripe

# Build with custom tag
./scripts/build-app.sh stripe my-registry/saleor-app-stripe:v1.0.0
```

## Available Apps

The following apps can be built and deployed:

- `stripe` - Payment processing with Stripe
- `cms` - Content management system integration  
- `klaviyo` - Email marketing automation
- `search` - Product search with Algolia
- `segment` - Analytics and customer data platform
- `smtp` - Email delivery service
- `avatax` - Tax calculation service
- `np-atobarai` - Japanese payment method
- `products-feed` - Product feed generation

## Configuration

### Environment Variables

Each app requires specific environment variables. Create app-specific `.env` files:

#### Stripe App (.env.stripe)
```bash
# Saleor Configuration
SALEOR_API_URL=https://your-saleor-instance.com/graphql/
SALEOR_APP_TOKEN=your-app-token
SALEOR_WEBHOOK_SECRET=your-webhook-secret

# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# App Configuration
NEXT_PUBLIC_SALEOR_API_URL=https://your-saleor-instance.com/graphql/
APP_LOG_LEVEL=info

# Optional: Database (for app configuration storage)
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=us-east-1
```

#### CMS App (.env.cms)
```bash
SALEOR_API_URL=https://your-saleor-instance.com/graphql/
SALEOR_APP_TOKEN=your-app-token
CMS_PROVIDER=contentful
CONTENTFUL_SPACE_ID=your-space-id
CONTENTFUL_ACCESS_TOKEN=your-token
```

### Health Checks

All apps include health check endpoints at `/api/health` for monitoring and load balancer integration.

## Dockerfile Explained

The multi-stage Dockerfile is optimized for:

### 1. **Base Stage**
- Sets up Node.js 22 Alpine
- Installs pnpm package manager
- Copies workspace configuration

### 2. **Dependencies Stage** 
- Installs all monorepo dependencies
- Leverages PNPM workspace resolution
- Enables Docker layer caching

### 3. **Source Stage**
- Copies all source code
- Maintains monorepo structure
- Includes shared packages

### 4. **Builder Stage**
- Builds specific app using Turbo
- Generates GraphQL types
- Validates app exists

### 5. **Runner Stage (Production)**
- Minimal production image
- Security hardening (non-root user)
- Health checks included
- Optimized for container orchestration

### 6. **Development Stage**
- Includes all dev dependencies
- Hot reload support
- Debug-friendly setup

## Build Optimization

### Layer Caching
The Dockerfile is structured to maximize Docker layer caching:

1. Package configuration files copied first
2. Dependencies installed before source code
3. Build outputs cached separately

### Multi-Stage Benefits
- **Smaller production images**: Only runtime dependencies included
- **Build caching**: Shared layers across different apps
- **Security**: Production images don't include build tools
- **Flexibility**: Different targets for different use cases

## Deployment Strategies

### 1. Single App Deployment

```bash
# Build specific app
docker build --build-arg APP_NAME=stripe -t saleor-app-stripe .

# Deploy to production
docker run -d \
  --name saleor-stripe-prod \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env.stripe \
  saleor-app-stripe
```

### 2. Container Orchestration

#### Kubernetes Example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: saleor-app-stripe
spec:
  replicas: 3
  selector:
    matchLabels:
      app: saleor-app-stripe
  template:
    metadata:
      labels:
        app: saleor-app-stripe
    spec:
      containers:
      - name: stripe-app
        image: saleor-app-stripe:latest
        ports:
        - containerPort: 3000
        env:
        - name: STRIPE_SECRET_KEY
          valueFrom:
            secretKeyRef:
              name: stripe-secrets
              key: secret-key
        livenessProbe:
          httpGet:
            path: /api/health
            port: 3000
          initialDelaySeconds: 30
        readinessProbe:
          httpGet:
            path: /api/health
            port: 3000
          initialDelaySeconds: 5
```

### 3. CI/CD Integration

```yaml
# GitHub Actions example
name: Build and Deploy Saleor App
on:
  push:
    branches: [main]
    paths: ['apps/stripe/**', 'packages/**']

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Build Stripe App
        run: |
          docker build \
            --build-arg APP_NAME=stripe \
            --tag ${{ secrets.REGISTRY }}/saleor-app-stripe:${{ github.sha }} \
            .
      
      - name: Push to Registry
        run: |
          docker push ${{ secrets.REGISTRY }}/saleor-app-stripe:${{ github.sha }}
```

## Development Workflow

### Local Development
```bash
# Start development environment
APP_NAME=stripe docker-compose up dev

# The app will be available at http://localhost:3000 with hot reload
```

### Testing Builds
```bash
# Test production build locally
docker build --build-arg APP_NAME=stripe -t test-stripe .
docker run --rm -p 3000:3000 --env-file .env.stripe test-stripe
```

### Debugging
```bash
# Run with shell access
docker run -it --entrypoint /bin/sh saleor-app-stripe

# Check logs
docker logs saleor-app-stripe

# Development with debugging
docker-compose up dev
# App runs with NODE_OPTIONS='--inspect' for debugging
```

## Benefits of This Approach

1. **Git Synchronization**: Keep full monorepo structure, easy to sync with upstream
2. **Single Source of Truth**: All apps share the same base packages and configurations
3. **Efficient Builds**: Turbo and Docker layer caching optimize build times
4. **Production Ready**: Multi-stage builds create minimal, secure production images
5. **Flexibility**: Deploy single apps or multiple apps as needed
6. **Developer Experience**: Consistent tooling and workflow across all apps

## Troubleshooting

### Common Issues

1. **Build fails with "APP_NAME is required"**
   ```bash
   # Make sure to pass the APP_NAME build argument
   docker build --build-arg APP_NAME=stripe -t saleor-app-stripe .
   ```

2. **App doesn't exist error**
   ```bash
   # Check available apps
   ls apps/
   # Ensure the app name matches the directory name
   ```

3. **Permission errors**
   ```bash
   # The app runs as non-root user (nextjs:1001)
   # Ensure any mounted volumes have correct permissions
   sudo chown -R 1001:1001 /path/to/data
   ```

4. **Health check failures**
   ```bash
   # Check if the app is responding
   curl http://localhost:3000/api/health
   # Check container logs for errors
   docker logs [container-name]
   ```

This approach provides the best of both worlds: maintaining the monorepo structure for easy updates while enabling individual app deployments for production scalability.