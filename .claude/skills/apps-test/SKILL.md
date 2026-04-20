---
name: apps-test
description: Run Vitest tests in saleor-apps with workspace awareness. Use when asked to "run tests", "test this", or any test execution task in saleor-apps/. Knows Vitest workspaces, per-app filtering, and integration test setup.
---

# Apps Test Runner

The apps monorepo uses Vitest with workspace configuration.

## Identifying the App

Tests are scoped to individual apps. Identify the app from context:
- File path: `apps/<app-name>/src/...` → filter is `<app-name>`
- Or run from the app directory

## Unit Tests

### From monorepo root
```bash
pnpm --filter <app-name> test
```

### From app directory
```bash
npx vitest --project unit <pattern>
```

### Specific test file
```bash
npx vitest --project unit src/modules/taxes/tax-calculator.test.ts
```

## Integration Tests

Integration tests require DynamoDB local to be running.

### Start DynamoDB local (if not running)
```bash
docker compose up dynamodb-local -d
```

### Run integration tests
```bash
npx vitest --project integration
```

### Specific integration test
```bash
npx vitest --project integration src/modules/taxes/tax-repository.integration.test.ts
```

## E2E Tests

E2E tests need a running Saleor instance and use PactumJS.

```bash
pnpm e2e
```

## Vitest Workspaces

The apps use Vitest workspaces with different environments:
- `unit` — jsdom environment, fast, no external deps
- `integration` — different env, needs DynamoDB local

Always specify `--project unit` or `--project integration` to avoid confusion.

## Test Selection

Run most-likely-to-fail first:
1. The specific test file you changed or created
2. Related tests in the same module
3. All tests in the app: `pnpm --filter <app-name> test`

## Writing Tests

- Use `describe`/`it` blocks with clear descriptions
- Follow the Result pattern (neverthrow) for testing service functions
- Mock external dependencies at boundaries (API clients, DB)
- Integration tests should use real DynamoDB local, not mocks
