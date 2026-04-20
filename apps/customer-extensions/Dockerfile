# syntax=docker/dockerfile:1
# docker build -f apps/customer-extensions/Dockerfile -t mrfakename/customer-extensions-app:latest .
# docker push mrfakename/customer-extensions-app:latest

# Stage 1: Dependencies
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat curl python3 make g++
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy workspace root files for monorepo support
COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc* ./
COPY package.json ./

# Copy all package.json files preserving directory structure
COPY packages ./packages
COPY apps/customer-extensions/package.json ./apps/customer-extensions/

# Remove source files from packages, keep only package.json and structure
RUN find ./packages -type f ! -name "package.json" ! -name "tsconfig.json" -delete 2>/dev/null || true

# Install all dependencies (not using --filter to ensure all workspace deps are resolved)
RUN pnpm install --frozen-lockfile

# Stage 2: Builder
FROM node:20-alpine AS builder
WORKDIR /app

# Install pnpm and build tools
RUN apk add --no-cache libc6-compat python3 make g++
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy workspace configuration
COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc* ./
COPY package.json ./

# Copy entire dependency structure from deps stage
# This includes root node_modules and all workspace packages with their dependencies
COPY --from=deps /app ./

# Now overlay source code on top (this adds src files while keeping node_modules)
COPY packages ./packages
COPY apps/customer-extensions ./apps/customer-extensions

# Set working directory to the app
WORKDIR /app/apps/customer-extensions

# Set build-time environment variables
ARG NEXT_PUBLIC_SALEOR_API_URL
ARG NEXT_PUBLIC_CUSTOMER_EXTENSIONS_APP_URL

ENV NEXT_PUBLIC_SALEOR_API_URL=$NEXT_PUBLIC_SALEOR_API_URL
ENV NEXT_PUBLIC_CUSTOMER_EXTENSIONS_APP_URL=$NEXT_PUBLIC_CUSTOMER_EXTENSIONS_APP_URL

# Disable telemetry during build
ENV NEXT_TELEMETRY_DISABLED=1

# Set NODE_OPTIONS to increase memory for build
ENV NODE_OPTIONS="--max_old_space_size=4096"

# Generate GraphQL types and build
RUN pnpm run generate
RUN pnpm run build

# Stage 3: Runner
FROM node:20-alpine AS runner
WORKDIR /app

# Set to production
ENV NODE_ENV=production

# Disable telemetry at runtime
ENV NEXT_TELEMETRY_DISABLED=1

# Create a non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy public assets
COPY --from=builder /app/apps/customer-extensions/public ./public

# Set correct permissions for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Copy standalone output
# The standalone output includes only necessary dependencies
COPY --from=builder --chown=nextjs:nodejs /app/apps/customer-extensions/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/customer-extensions/.next/static ./apps/customer-extensions/.next/static

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 3010

# Set default port
ENV PORT=3010
ENV HOSTNAME="0.0.0.0"

# Runtime environment variables (will be injected at runtime)
# Core
ENV SECRET_KEY=""
ENV ALLOWED_DOMAIN_PATTERN=""

# APL
ENV APL=""

# DynamoDB
ENV DYNAMODB_MAIN_TABLE_NAME=""
ENV AWS_REGION=""
ENV AWS_ACCESS_KEY_ID=""
ENV AWS_SECRET_ACCESS_KEY=""
ENV INIT_DYNAMODB_ON_STARTUP=""

# Saleor API
ENV SALEOR_API_URL=""

# Start the application
CMD ["node", "apps/customer-extensions/server.js"]
