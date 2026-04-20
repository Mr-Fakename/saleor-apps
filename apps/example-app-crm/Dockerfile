# docker build -f apps/example-app-crm/Dockerfile -t mrfakename/crm-app:latest .
# docker push mrfakename/crm-app:latest

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
RUN npm install -g pnpm turbo
WORKDIR /app

# Prune the workspace for the target app
FROM base AS pruner
COPY . .
RUN turbo prune --scope=crm --docker

# Install dependencies only when needed
FROM base AS installer
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

# Build the app and its dependencies
COPY --from=pruner /app/out/full/ .
COPY turbo.json turbo.json

# Create a build-time .env file with placeholder values
RUN echo "NODE_ENV=production" > /app/apps/example-app-crm/.env && \
    echo "SECRET_KEY=placeholder_secret_key_for_build_only" >> /app/apps/example-app-crm/.env && \
    echo "DYNAMODB_MAIN_TABLE_NAME=placeholder_table" >> /app/apps/example-app-crm/.env && \
    echo "AWS_REGION=us-east-1" >> /app/apps/example-app-crm/.env && \
    echo "AWS_ACCESS_KEY_ID=placeholder_key" >> /app/apps/example-app-crm/.env && \
    echo "AWS_SECRET_ACCESS_KEY=placeholder_secret" >> /app/apps/example-app-crm/.env

ENV NODE_ENV=production
RUN turbo build --filter=crm

# Runtime stage
FROM base AS runner
WORKDIR /app

# Don't run production as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
USER nextjs

# Copy built application
COPY --from=installer --chown=nextjs:nodejs /app/apps/example-app-crm/.next/standalone ./
COPY --from=installer --chown=nextjs:nodejs /app/apps/example-app-crm/.next/static ./apps/example-app-crm/.next/static
COPY --from=installer --chown=nextjs:nodejs /app/apps/example-app-crm/public ./apps/example-app-crm/public

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/example-app-crm/server.js"]
