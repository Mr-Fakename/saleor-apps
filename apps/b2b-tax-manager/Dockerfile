# docker build -f apps/b2b-tax-manager/Dockerfile -t mrfakename/b2b-tax-manager-app:latest .
# docker push mrfakename/b2b-tax-manager-app:latest

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
RUN npm install -g pnpm turbo
WORKDIR /app

# Prune the workspace for the target app
FROM base AS pruner
COPY . .
RUN turbo prune --scope=saleor-app-b2b-tax-manager --docker

# Install dependencies only when needed
FROM base AS installer
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

# Build the app and its dependencies
COPY --from=pruner /app/out/full/ .
COPY turbo.json turbo.json

# Create a build-time .env file with placeholder values
RUN echo "NODE_ENV=production" > /app/apps/b2b-tax-manager/.env && \
    echo "B2B_TAX_MANAGER_API_KEY=placeholder_key_for_build_only" >> /app/apps/b2b-tax-manager/.env && \
    echo "SELLER_VAT_NUMBER=FR00000000000" >> /app/apps/b2b-tax-manager/.env

ENV NODE_ENV=production
RUN turbo build --filter=saleor-app-b2b-tax-manager

# Runtime stage
FROM base AS runner
WORKDIR /app

# Don't run production as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
USER nextjs

# Copy built application
COPY --from=installer --chown=nextjs:nodejs /app/apps/b2b-tax-manager/.next/standalone ./
COPY --from=installer --chown=nextjs:nodejs /app/apps/b2b-tax-manager/.next/static ./apps/b2b-tax-manager/.next/static
COPY --from=installer --chown=nextjs:nodejs /app/apps/b2b-tax-manager/public ./apps/b2b-tax-manager/public

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/b2b-tax-manager/server.js"]
