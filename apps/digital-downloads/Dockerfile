# docker build -f apps/digital-downloads/Dockerfile -t mrfakename/digital-downloads-app:latest .
# docker push mrfakename/digital-downloads-app:latest

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
RUN npm install -g pnpm turbo
WORKDIR /app

# Prune the workspace for the target app
FROM base AS pruner
COPY . .
RUN turbo prune --scope=saleor-app-digital-downloads --docker

# Install dependencies only when needed
FROM base AS installer
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

# Build the app and its dependencies
COPY --from=pruner /app/out/full/ .
COPY turbo.json turbo.json

# Create a build-time .env file with placeholder values
RUN echo "NODE_ENV=production" > /app/apps/digital-downloads/.env && \
    echo "SECRET_KEY=placeholder_secret_key_for_build_only" >> /app/apps/digital-downloads/.env && \
    echo "DYNAMODB_MAIN_TABLE_NAME=placeholder_table" >> /app/apps/digital-downloads/.env && \
    echo "AWS_REGION=us-east-1" >> /app/apps/digital-downloads/.env && \
    echo "AWS_ACCESS_KEY_ID=placeholder_key" >> /app/apps/digital-downloads/.env && \
    echo "AWS_SECRET_ACCESS_KEY=placeholder_secret" >> /app/apps/digital-downloads/.env && \
    echo "AWS_ENDPOINT_URL=http://localhost:8001" >> /app/apps/digital-downloads/.env && \
    echo "TOKEN_EXPIRY_HOURS=72" >> /app/apps/digital-downloads/.env && \
    echo "MAX_DOWNLOADS=5" >> /app/apps/digital-downloads/.env

ENV NODE_ENV=production
# Generate GraphQL types before building
RUN cd /app/apps/digital-downloads && pnpm run generate:app-graphql-types || true
RUN turbo build --filter=saleor-app-digital-downloads

# Runtime stage
FROM base AS runner
WORKDIR /app

# Don't run production as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
USER nextjs

# Copy built application
COPY --from=installer --chown=nextjs:nodejs /app/apps/digital-downloads/.next/standalone ./
COPY --from=installer --chown=nextjs:nodejs /app/apps/digital-downloads/.next/static ./apps/digital-downloads/.next/static
COPY --from=installer --chown=nextjs:nodejs /app/apps/digital-downloads/public ./apps/digital-downloads/public
COPY --from=installer --chown=nextjs:nodejs /app/apps/digital-downloads/scripts/setup-dynamodb.js ./apps/digital-downloads/scripts/setup-dynamodb.js

EXPOSE 3003
ENV PORT=3003
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/digital-downloads/server.js"]
