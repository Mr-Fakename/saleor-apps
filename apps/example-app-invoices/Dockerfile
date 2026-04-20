# Base image with common setup
FROM node:22-alpine AS base
WORKDIR /app
# Next.js often benefits from libc6-compat on Alpine
RUN apk add --no-cache libc6-compat
# Enable pnpm via Corepack
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable

# Dependencies layer (better caching)
FROM base AS deps
COPY pnpm-lock.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Builder: copy source and build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
# Copy the rest of the app (keep layers cache-friendly)
COPY . .
# Build the app (runs `pnpm generate && next build`)
RUN pnpm build

# Optionally prune dev dependencies for slimmer runtime
RUN pnpm prune --prod

# Runner: minimal runtime image
FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat
ENV NODE_ENV=production
ENV PORT=3000

# Create non-root user
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

# Copy only the runtime artifacts
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.js ./next.config.js
# If you use env-specific next.config.* files, copy them similarly.

# Production dependencies only
COPY --from=builder /app/node_modules ./node_modules

# Create temp directory with proper permissions
RUN mkdir -p /app/temp && chown -R nextjs:nodejs /app/temp

# Switch to non-root
USER nextjs

EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]