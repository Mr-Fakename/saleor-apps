# Multi-stage Dockerfile for deploying single Saleor apps from monorepo
# Can be used independently without CLI arguments by setting APP_NAME environment variable
# Usage: 
#   docker build --build-arg APP_NAME=stripe -t saleor-app-stripe .
#   docker build -t saleor-apps . (builds all apps)
#   docker run -e APP_NAME=stripe saleor-apps

# ============================================================================
# BASE STAGE - Common setup for all apps with AWS CLI
# ============================================================================
FROM node:22-alpine AS base

# Install system dependencies including AWS CLI
RUN apk add --no-cache \
    libc6-compat \
    python3 \
    py3-pip \
    bash \
    curl \
    dumb-init \
    && pip3 install --break-system-packages --no-cache-dir awscli \
    && rm -rf /var/cache/apk/* /tmp/*

# Enable pnpm
ENV PNPM_HOME="/usr/local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.6.3 --activate

# Set working directory
WORKDIR /app

# Copy workspace configuration
COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY pnpm-lock.yaml ./

# Copy turbo configuration
COPY turbo.json ./

# ============================================================================
# DEPENDENCIES STAGE - Install all dependencies
# ============================================================================
FROM base AS deps

# Copy all files first (following original working approach)
COPY . .

# Install dependencies as root to avoid permission issues  
RUN echo "=== Installing dependencies ===" && \
    pnpm install --frozen-lockfile

# ============================================================================
# SOURCE STAGE - Copy source code (simplified since deps stage has everything)
# ============================================================================
FROM deps AS source

# Source code already copied in deps stage
# Just ensure proper permissions will be set later

# ============================================================================
# BUILD STAGE - Build the specific app and its dependencies
# ============================================================================
FROM source AS builder

# Build argument to specify which app to build (optional for multi-app builds)
ARG APP_NAME
ENV APP_NAME=${APP_NAME}

# Only validate APP_NAME if provided - allows building all apps
RUN if [ ! -z "$APP_NAME" ]; then \
        if [ ! -d "apps/${APP_NAME}" ]; then \
            echo "ERROR: App 'apps/${APP_NAME}' does not exist"; \
            echo "Available apps:"; \
            ls -1 apps/; \
            exit 1; \
        fi \
    fi


# Create nextjs user for the build process
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Build exactly like local (following original working approach)
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Set dummy environment variables for build process
ENV SECRET_KEY=dummy-secret-key-for-build
ENV DYNAMODB_MAIN_TABLE_NAME=dummy-table
ENV AWS_REGION=us-east-1
ENV AWS_ACCESS_KEY_ID=dummy-access-key
ENV AWS_SECRET_ACCESS_KEY=dummy-secret-key

# Build specific app or skip build for runtime flexibility
RUN if [ ! -z "$APP_NAME" ]; then \
        echo "=== Building single app: ${APP_NAME} ==="; \
        cd apps/${APP_NAME} && \
        pnpm install && \
        # Set required env vars for build
        export APL=file && \
        export SECRET_KEY=dummy-build-key && \
        export NEXT_PUBLIC_SALEOR_API_URL=http://localhost:8000/graphql/ && \
        pnpm build && \
        echo "=== Build completed for ${APP_NAME} ==="; \
    else \
        echo "=== Skipping build - will build at runtime for flexibility ==="; \
        echo "All apps will be available for runtime selection"; \
    fi

# ============================================================================
# DEVELOPMENT STAGE - For development with hot reload
# ============================================================================
FROM source AS development

ARG APP_NAME
ENV APP_NAME=${APP_NAME}

# Install development dependencies
RUN pnpm install

# Generate types for development
RUN pnpm turbo run generate --filter="@saleor/app-*-${APP_NAME}"

# Set development environment
ENV NODE_ENV=development

# Expose port for development
EXPOSE 3000

# Development command
CMD ["sh", "-c", "pnpm --filter=@saleor/app-*-${APP_NAME} dev"]

# ============================================================================
# RUNNER STAGE - Production runtime with AWS CLI (DEFAULT STAGE)
# ============================================================================
FROM node:22-alpine AS runner

# Install system dependencies including AWS CLI (matching base stage)
RUN apk add --no-cache \
    libc6-compat \
    python3 \
    py3-pip \
    bash \
    curl \
    dumb-init \
    && pip3 install --break-system-packages --no-cache-dir awscli \
    && rm -rf /var/cache/apk/* /tmp/*

# Enable pnpm
ENV PNPM_HOME="/usr/local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Create app user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Set working directory
WORKDIR /app

# Build argument to specify which app to run (can be overridden at runtime)
ARG APP_NAME
ENV APP_NAME=${APP_NAME}

# Default app for standalone testing
ENV DEFAULT_APP_NAME=stripe

# Set environment variables
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Copy entire built application (following original working approach)
COPY --from=builder --chown=nextjs:nodejs /app ./

# Fix ownership for all files
RUN chown -R nextjs:nodejs /app

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl --fail http://localhost:3000/api/health || exit 1

# Create a startup script that can handle runtime APP_NAME selection
COPY <<EOF /app/start-app.sh
#!/bin/bash
set -e

# Use runtime APP_NAME if provided, otherwise use build-time APP_NAME, otherwise use default
RUNTIME_APP_NAME=\${APP_NAME:-\${DEFAULT_APP_NAME}}

if [ -z "\$RUNTIME_APP_NAME" ]; then
    echo "ERROR: No app specified. Available apps:"
    ls -1 /app/apps/
    echo "Set APP_NAME environment variable to one of the above."
    exit 1
fi

if [ ! -d "/app/apps/\$RUNTIME_APP_NAME" ]; then
    echo "ERROR: App '\$RUNTIME_APP_NAME' does not exist"
    echo "Available apps:"
    ls -1 /app/apps/
    exit 1
fi

echo "Starting app: \$RUNTIME_APP_NAME"
cd /app/apps/\$RUNTIME_APP_NAME

# Check if the app was built
if [ ! -d ".next" ]; then
    echo "App \$RUNTIME_APP_NAME not built. Building now..."
    # Set required environment variables for build
    export APL=\${APL:-file}
    export SECRET_KEY=\${SECRET_KEY:-runtime-build-key}
    export NEXT_PUBLIC_SALEOR_API_URL=\${NEXT_PUBLIC_SALEOR_API_URL:-http://localhost:8000/graphql/}
    export SALEOR_API_URL=\${SALEOR_API_URL:-http://localhost:8000/graphql/}
    
    echo "Building with environment variables:"
    echo "- APL=\$APL"
    echo "- SALEOR_API_URL=\$SALEOR_API_URL"
    echo "- NODE_ENV=\$NODE_ENV"
    
    pnpm build || (echo "Build failed. Starting in development mode..." && pnpm dev)
else
    echo "Starting Next.js app in production mode..."
    pnpm start || npm start
fi
EOF

RUN chmod +x /app/start-app.sh

# Start the application with dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["/app/start-app.sh"]