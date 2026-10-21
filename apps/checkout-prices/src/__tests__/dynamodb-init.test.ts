import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTableIfNotExists, initializeDynamoDB } from "../instrumentations/dynamodb-init";

/** DynamoDB client double: records every command, answers via `respond`. */
function mockDynamo(respond: (command: unknown) => unknown) {
  const sent: unknown[] = [];
  const fake = {
    send: vi.fn(async (command: unknown) => {
      sent.push(command);
      const result = respond(command);

      if (result instanceof Error) {
        throw result;
      }

      return result;
    }),
  };

  return { client: fake as unknown as DynamoDBClient, sent };
}

const notFound = () => new ResourceNotFoundException({ message: "Requested resource not found", $metadata: {} });

describe("DynamoDB startup initialization", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("creates the main table (PK hash / SK range) when it is missing", async () => {
    const { client, sent } = mockDynamo((command) => (command instanceof DescribeTableCommand ? notFound() : {}));

    await expect(createTableIfNotExists(client, "checkout-prices-main-table")).resolves.toBe("created");

    expect(sent).toHaveLength(2);
    expect(sent[0]).toBeInstanceOf(DescribeTableCommand);
    expect(sent[1]).toBeInstanceOf(CreateTableCommand);
    const create = sent[1] as CreateTableCommand;

    expect(create.input.TableName).toBe("checkout-prices-main-table");
    expect(create.input.KeySchema).toStrictEqual([
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ]);
    expect(create.input.AttributeDefinitions).toStrictEqual([
      { AttributeName: "PK", AttributeType: "S" },
      { AttributeName: "SK", AttributeType: "S" },
    ]);
  });

  it("is a no-op when the table already exists", async () => {
    const { client, sent } = mockDynamo(() => ({ Table: { TableName: "t", TableStatus: "ACTIVE" } }));

    await expect(createTableIfNotExists(client, "t")).resolves.toBe("exists");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(DescribeTableCommand);
  });

  it("treats a concurrent creation (ResourceInUseException) as success", async () => {
    const { client } = mockDynamo((command) =>
      command instanceof DescribeTableCommand
        ? notFound()
        : new ResourceInUseException({ message: "Table already exists", $metadata: {} }),
    );

    await expect(createTableIfNotExists(client, "t")).resolves.toBe("exists");
  });

  it("resolves the table name like the APL does (DYNAMODB_MAIN_TABLE_NAME first)", async () => {
    vi.stubEnv("DYNAMODB_MAIN_TABLE_NAME", "main-from-env");
    vi.stubEnv("CHECKOUT_PRICES_DYNAMODB_TABLE", "legacy-name");
    const { client, sent } = mockDynamo((command) => (command instanceof DescribeTableCommand ? notFound() : {}));

    await initializeDynamoDB(client);

    expect((sent[1] as CreateTableCommand).input.TableName).toBe("main-from-env");
  });

  it("falls back to CHECKOUT_PRICES_DYNAMODB_TABLE, then the default name", async () => {
    vi.stubEnv("DYNAMODB_MAIN_TABLE_NAME", "");
    vi.stubEnv("CHECKOUT_PRICES_DYNAMODB_TABLE", "legacy-name");
    const first = mockDynamo(() => ({ Table: {} }));

    await initializeDynamoDB(first.client);
    expect((first.sent[0] as DescribeTableCommand).input.TableName).toBe("legacy-name");

    vi.stubEnv("CHECKOUT_PRICES_DYNAMODB_TABLE", "");
    const second = mockDynamo(() => ({ Table: {} }));

    await initializeDynamoDB(second.client);
    expect((second.sent[0] as DescribeTableCommand).input.TableName).toBe("checkout-prices-main-table");
  });

  it("never throws: a DynamoDB outage is logged and startup continues", async () => {
    const { client } = mockDynamo(() => new Error("connect ECONNREFUSED dynamodb:8001"));

    await expect(initializeDynamoDB(client)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("instrumentation register()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("../instrumentations/dynamodb-init");
    vi.resetModules();
  });

  async function loadRegisterWithMockedInit() {
    const initializeDynamoDBMock = vi.fn(async () => undefined);

    vi.resetModules();
    vi.doMock("../instrumentations/dynamodb-init", () => ({ initializeDynamoDB: initializeDynamoDBMock }));
    const { register } = await import("../instrumentation");

    return { register, initializeDynamoDBMock };
  }

  it("initializes DynamoDB on the Node.js runtime when INIT_DYNAMODB_ON_STARTUP=true", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("INIT_DYNAMODB_ON_STARTUP", "true");
    const { register, initializeDynamoDBMock } = await loadRegisterWithMockedInit();

    await register();

    expect(initializeDynamoDBMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["flag unset", "nodejs", ""],
    ["flag false", "nodejs", "false"],
    ["edge runtime", "edge", "true"],
  ])("skips initialization (%s)", async (_label, runtime, flag) => {
    vi.stubEnv("NEXT_RUNTIME", runtime);
    vi.stubEnv("INIT_DYNAMODB_ON_STARTUP", flag);
    const { register, initializeDynamoDBMock } = await loadRegisterWithMockedInit();

    await register();

    expect(initializeDynamoDBMock).not.toHaveBeenCalled();
  });
});
