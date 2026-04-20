# Saleor Apps

> Inherits from root [`CLAUDE.md`](../CLAUDE.md) — agent strategy, code principles, and continuous improvement apply here.

## Project Structure

**Monorepo Architecture**: Turborepo-managed monorepo of Saleor Apps built with Next.js, TypeScript, and modern tooling.

- `/apps/` - Individual Saleor applications (AvaTax, CMS, Klaviyo, Products Feed, Search, Segment, SMTP, Stripe, NP Atobarai) + example apps (Abandoned Checkouts, Authorize.Net, Checkout Prices, CRM, Customer Insights, Invoices, Klarna)
- `/packages/` - Shared libraries and utilities (domain, errors, logger, otel, UI components, etc.)
- `/templates/` - App templates for new development
- Uses PNPM workspaces with workspace dependencies via `workspace:*`

**Domain-Driven Design**: Each app follows modular architecture:

- `src/modules/` - Domain-specific business logic modules
- `src/app/api/` - Next.js App Router API routes (webhooks)
- `src/pages/` - Legacy Pages Router for some apps
- Business logic encapsulated in domain entities and use cases

## Essential Commands

**Development**:

- `pnpm dev` - Start all apps in development mode
- `pnpm --filter <app-name> dev` - Start specific app (e.g., `pnpm --filter saleor-app-avatax dev`)
- `pnpm dev:debug` - Start with debug logging (app-level)

**Building & Type Checking**:

- `pnpm build` - Build all apps and packages
- `pnpm check-types` - Type check all projects
- `tsc --noEmit` - Type check specific app (run in app directory)

**Testing**:

- `pnpm test:ci` - Run unit tests for all projects
- `vitest --project units` - Run unit tests for specific app
- `vitest --project e2e` - Run E2E tests for specific app
- `pnpm e2e` - Run E2E tests (app-level)

**Linting & Formatting**:

- `pnpm lint` - Lint all projects
- `pnpm lint:fix` - Auto-fix linting issues
- `pnpm format` - Format all code with Prettier
- `eslint .` - Lint specific app (run in app directory)

**Code Generation**:

- `pnpm generate` - Generate GraphQL types for all projects
- `pnpm run generate:app` - Generate app-specific GraphQL types
- `pnpm run generate:e2e` - Generate E2E test GraphQL types

## Architecture Patterns

**Result-Based Error Handling**: Uses `neverthrow` library extensively. Functions return `Result<T, E>` instead of throwing exceptions:

- Test success: `result._unsafeUnwrap()`
- Test errors: `result._unsafeUnwrapErr()`

**Branded Types with Zod**: Follow ADR 0002 for type safety on primitives:

```typescript
const saleorApiUrlSchema = z.string().url().endsWith("/graphql/").brand("SaleorApiUrl");
export const createSaleorApiUrl = (raw: string) => saleorApiUrlSchema.parse(raw);
```

**Error Classes**: Use `BaseError.subclass()` pattern from `@saleor/apps-errors`:

```typescript
static ValidationError = BaseError.subclass("ValidationError", {
  props: { _brand: "AppChannelConfig.ValidationError" as const },
});
```

**Repository Pattern**: Data access through repository interfaces, typically backed by DynamoDB via `@saleor/dynamo-config-repository`.

**Use Cases**: Webhook handlers delegate to use case classes that contain business logic. Use cases extend `BaseUseCase` for shared config loading patterns.

## Key Technologies

**Frontend**: Next.js (App Router + Pages Router), React, TypeScript, Macaw UI, React Hook Form with Zod resolvers

**Backend**: tRPC for type-safe API layer, GraphQL with code generation, Webhook handling

**Database**: DynamoDB for configuration storage, repositories for data access

**Testing**: Vitest with workspace configuration, React Testing Library, PactumJS for E2E tests

**Observability**: OpenTelemetry instrumentation, Sentry error tracking, structured logging with contextual loggers

**Tooling**: Turborepo, PNPM workspaces, ESLint with custom configs, Prettier

## Testing Conventions

**Unit Tests**: Located in `src/**/*.test.ts`, use Vitest with jsdom environment
**E2E Tests**: Located in `e2e/**/*.spec.ts`, use PactumJS for API testing
**Setup**: Apps use `src/setup-tests.ts` for unit test setup, `e2e/setup.ts` for E2E setup
**Mocking**: Mock objects in `src/__tests__/mocks/`, use `vi.spyOn()` for method spying

## Integration Points

**Saleor Integration**: Apps receive webhooks at `/api/webhooks/saleor/`, use webhook definitions in `webhooks.ts` for registration

**External APIs**: Payment providers (Stripe, NP Atobarai), tax services (AvaTax), CMS systems, etc. wrapped in domain-specific client classes

**Configuration**: Apps store configuration in DynamoDB, access via repository pattern with app metadata management

## Development Workflow

1. **Environment Setup**: Each app has `.env.example` - copy to `.env.local` with required values
2. **Schema Generation**: Run `pnpm generate` after GraphQL schema changes
3. **Type Safety**: All apps use strict TypeScript - ensure no `any` types
4. **Testing**: Write unit tests alongside features, E2E tests for critical workflows
5. **Linting**: Code must pass ESLint rules including custom app-specific rules like `n/no-process-env`
6. **Changeset**: Functional changes, like new features or fixes should have changeset attached. Do not attach it if code changes do not have visible impact to the user, like refactor. To run changeset:
    - Execute `pnpm changeset add` from root directory
    - Select affected app(s) or package(s)
    - If many changes applied in single commit, create multiple changesets
    - Ensure changeset has a good value, describing what was the actual change. It should be less technical than the commit. Best if it has before/after described.

## CRITICAL: Creating New Apps

When creating a new Saleor App, these rules are **non-negotiable**. Violations will cause build failures.

### Reference Apps (MUST copy patterns from these)

Use **modern production apps** as reference — NEVER `example-*` apps (they are legacy/outdated):

| Pattern | Reference App | File |
|---|---|---|
| `_app.tsx` (AppBridge + tRPC) | `apps/smtp/src/pages/_app.tsx` | |
| tRPC context | `apps/cms/src/modules/trpc/trpc-context.ts` | Uses `@saleor/app-sdk/headers` |
| tRPC client | `apps/cms/src/modules/trpc/trpc-client.ts` | Uses `appBridgeInstance?.getState()` |
| Manifest + register | `apps/smtp/src/pages/api/manifest.ts` | |
| Webhook handler | `apps/smtp/src/pages/api/webhooks/` | SaleorAsyncWebhook pattern |
| Macaw UI usage | `apps/smtp/src/pages/configuration/` | `Text size={N} fontWeight="bold"` |
| Dockerfile | `apps/stripe/Dockerfile` | Multi-stage turbo prune |
| `next.config.ts` | `apps/stripe/next.config.ts` | Needs `output: "standalone"` |

### Blocked Patterns (enforced by hooks)

| Pattern | Why | Correct |
|---|---|---|
| `from "@saleor/app-sdk/const"` | Path doesn't exist in current SDK | `from "@saleor/app-sdk/headers"` |
| `<Text variant="heading">` | Macaw UI v1.3.1 has no `variant` prop | `<Text size={7} fontWeight="bold">` |
| `<Button size="small">` | Not a valid Macaw UI prop | Remove `size` prop |
| `window.__SALEOR_*` globals | Non-standard, fragile | Use `appBridgeInstance?.getState()` |
| Test files in `src/pages/` | Next.js exposes them as routes | Place in `src/__tests__/` or `src/modules/*/__tests__/` |

### Build Verification (MANDATORY)

Every agent or task that creates/modifies app code MUST run these before reporting completion:

```bash
# 1. Build check (catches import errors, missing deps, route issues)
cd saleor-apps/apps/<app-name> && npx next build

# 2. Test check (catches logic errors)
cd saleor-apps/apps/<app-name> && npx vitest run

# 3. Type check (catches type mismatches — note: React types mismatch
#    in this monorepo requires typescript.ignoreBuildErrors in next.config)
cd saleor-apps/apps/<app-name> && npx tsc --noEmit
```

If `next build` fails due to `@types/react` version mismatch (`NoSSRWrapper cannot be used as JSX component`), add to `next.config.ts`:
```typescript
typescript: { ignoreBuildErrors: true }
```
This is a known monorepo issue — all apps have it. Type safety is enforced separately via `tsc --noEmit` with `skipLibCheck: true`.

### New App Checklist

Before declaring a new app complete:

- [ ] `package.json` name matches `saleor-app-<name>` (for turbo prune)
- [ ] `tsconfig.json` extends `@saleor/typescript-config-apps/base.json`
- [ ] `next.config.ts` has `output: "standalone"` and `typescript.ignoreBuildErrors: true`
- [ ] `Dockerfile` uses turbo prune pattern (copy from `apps/stripe/Dockerfile`)
- [ ] `docker-compose.yml` entry in `saleor-apps/docker-compose.yml`
- [ ] `docker-compose.yaml` entry in `saleor-platform/docker-compose.yaml`
- [ ] `.env` vars in `saleor-platform/.env`
- [ ] `graphql/schema.graphql` fetched (`pnpm fetch-schema`)
- [ ] `public/.gitkeep` exists (Dockerfile COPY target)
- [ ] `npx next build` passes
- [ ] `npx vitest run` passes (all tests green)
- [ ] No test files under `src/pages/`
- [ ] All imports verified against reference apps (not example-* apps)

### Agent Dispatch Rules for App Creation

When delegating app creation to sub-agents:

1. **ALWAYS include the reference file paths** in the agent prompt — don't let agents guess import paths
2. **NEVER let agents report completion without build verification** — the main agent must run `next build` + `vitest run`
3. **Split by concern, not by phase** — one agent for business logic (modules/), another for infrastructure (pages/api/, tRPC, manifest), verify integration yourself
4. **Provide exact Macaw UI examples** — copy working JSX from `apps/smtp/src/pages/` into the prompt

## App-Specific Notes

- **AvaTax**: Tax calculation service with comprehensive E2E testing suite
- **Stripe**: Payment processing with transaction handling use cases
- **Search**: Algolia integration with webhook-driven product indexing
- **SMTP**: Email service with template management
- **CMS**: Content management system integration with bulk sync capabilities
- **B2B Tax Manager**: VAT validation (VIES), tax exemption (FLAT_RATES + taxExemptionManage), reverse charge for EU B2B

Run commands from the root directory for global operations, or from individual app directories for app-specific tasks.
