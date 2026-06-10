# docker build -f apps/checkout-prices/Dockerfile -t mrfakename/checkout-app:latest .
# docker push mrfakename/checkout-app:latest
# Build context: saleor-apps/ root

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
# Enable corepack and use specific pnpm version for consistency
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/checkout-prices/package.json ./apps/checkout-prices/
# Use hoisted node-linker so node_modules contains real files, not pnpm symlinks.
# Next.js standalone file tracing cannot resolve pnpm's .pnpm/ virtual store.
RUN echo "node-linker=hoisted" > .npmrc && \
    pnpm install --filter saleor-app-checkout-prices --no-frozen-lockfile

# Build the application
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/checkout-prices/node_modules ./apps/checkout-prices/node_modules
COPY apps/checkout-prices ./apps/checkout-prices
WORKDIR /app/apps/checkout-prices

# ==============================================================================
# NEXT_PUBLIC_* values are inlined into the bundle at build time and only the
# browser-side dashboard page depends on them. Server-side code reads the
# RUNTIME env (SALEOR_API_URL / DEFAULT_CHANNEL — see src/const.ts), so the
# image works against any Saleor instance without a rebuild. The ARG default
# points at the current staging API; override at build for other deployments.
# ==============================================================================
ARG NEXT_PUBLIC_SALEOR_API_URL=https://dess-api.daybreakdevelopment.eu/graphql/
ARG NEXT_PUBLIC_DEFAULT_CHANNEL=default-channel
RUN echo "NEXT_PUBLIC_SALEOR_API_URL=${NEXT_PUBLIC_SALEOR_API_URL}" > .env && \
    echo "NEXT_PUBLIC_DEFAULT_CHANNEL=${NEXT_PUBLIC_DEFAULT_CHANNEL}" >> .env

ENV NEXT_PUBLIC_SALEOR_API_URL=${NEXT_PUBLIC_SALEOR_API_URL}
ENV NEXT_PUBLIC_DEFAULT_CHANNEL=${NEXT_PUBLIC_DEFAULT_CHANNEL}
ENV NODE_ENV=production
# Hoisted deps put binaries at the workspace root
ENV PATH="/app/node_modules/.bin:$PATH"

# Generate GraphQL types
RUN pnpm run generate

# Build Next.js app
RUN pnpm run build

# Production runtime
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME="0.0.0.0"
ENV PORT=3001

# Don't run as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy built application — outputFileTracingRoot is set to monorepo root,
# so standalone output uses monorepo-relative paths (apps/checkout-prices/server.js).
COPY --from=builder --chown=nextjs:nodejs /app/apps/checkout-prices/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/checkout-prices/.next/static ./apps/checkout-prices/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/checkout-prices/public ./apps/checkout-prices/public

# Copy initialization script
COPY --from=builder --chown=nextjs:nodejs /app/apps/checkout-prices/scripts/init-dynamodb.sh ./scripts/init-dynamodb.sh

# Create directory for auth data persistence
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

# Make init script executable
RUN chmod +x ./scripts/init-dynamodb.sh && \
    sed -i 's/\r$//' ./scripts/init-dynamodb.sh

# Create startup script BEFORE switching to nextjs user
RUN printf '#!/bin/sh\n\
echo "[STARTUP] Starting Next.js server..."\n\
HOSTNAME=0.0.0.0 node apps/checkout-prices/server.js &\n\
SERVER_PID=$!\n\
echo "[STARTUP] Server PID: $SERVER_PID"\n\
\n\
# Run DynamoDB initialization in background\n\
./scripts/init-dynamodb.sh &\n\
\n\
# Wait for the server process\n\
wait $SERVER_PID\n' > /app/start.sh && \
    chmod +x /app/start.sh && \
    chown nextjs:nodejs /app/start.sh

USER nextjs

EXPOSE 3001

CMD ["/app/start.sh"]
