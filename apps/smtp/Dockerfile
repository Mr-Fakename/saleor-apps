# docker build -f apps/smtp/Dockerfile -t mrfakename/saleor-app-smtp:latest .
# docker push mrfakename/saleor-app-smtp:latest

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
RUN npm install -g pnpm turbo
WORKDIR /app

# Prune the workspace for the target app
FROM base AS pruner
COPY . .
RUN turbo prune --scope=saleor-app-smtp --docker

# Install dependencies only when needed
FROM base AS installer
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

# Build the app and its dependencies
COPY --from=pruner /app/out/full/ .
COPY turbo.json turbo.json

ENV NODE_ENV=production
# Generate GraphQL types before building
RUN cd /app/apps/smtp && pnpm run generate || true
RUN turbo build --filter=saleor-app-smtp

# Runtime stage
FROM base AS runner
WORKDIR /app

# Don't run production as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
USER nextjs

# Copy built application
COPY --from=installer --chown=nextjs:nodejs /app/apps/smtp/.next/standalone ./
COPY --from=installer --chown=nextjs:nodejs /app/apps/smtp/.next/static ./apps/smtp/.next/static
COPY --from=installer --chown=nextjs:nodejs /app/apps/smtp/public ./apps/smtp/public

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/smtp/server.js"]
