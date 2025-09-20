FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
RUN npm install -g pnpm turbo
WORKDIR /app

# Prune the workspace for the target app
FROM base AS pruner
COPY . .
RUN turbo prune --scope=example-app-invoices --docker

# Install dependencies only when needed
FROM base AS installer
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

# Build the app and its dependencies
COPY --from=pruner /app/out/full/ .
COPY turbo.json turbo.json

# Create minimal build-time .env file
RUN echo "NODE_ENV=production" > /app/apps/example-app-invoices/.env

ENV NODE_ENV=production
RUN turbo build --filter=example-app-invoices

# Runtime stage
FROM base AS runner
WORKDIR /app

# Don't run production as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
USER nextjs

# Copy built application
COPY --from=installer --chown=nextjs:nodejs /app/apps/example-app-invoices/.next/standalone ./
COPY --from=installer --chown=nextjs:nodejs /app/apps/example-app-invoices/.next/static ./apps/example-app-invoices/.next/static
COPY --from=installer --chown=nextjs:nodejs /app/apps/example-app-invoices/public ./apps/example-app-invoices/public

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/example-app-invoices/server.js"]