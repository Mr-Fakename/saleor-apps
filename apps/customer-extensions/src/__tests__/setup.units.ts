import { afterEach, vi } from "vitest";

// Mock environment variables for unit tests
vi.mock("@/lib/env", () => ({
  env: {
    DYNAMODB_MAIN_TABLE_NAME: "test-table",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "test-key",
    AWS_SECRET_ACCESS_KEY: "test-secret",
    INIT_DYNAMODB_ON_STARTUP: "false",
    APL: "file",
    SECRET_KEY: "0123456789abcdef0123456789abcdef",
    ALLOWED_DOMAIN_PATTERN: ".*",
    SALEOR_API_URL: "http://localhost:8000/graphql/",
  },
}));

// Reset all mocks after each test
afterEach(() => {
  vi.clearAllMocks();
});
