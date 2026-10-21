// @vitest-environment node
import {
  CreateTableCommand,
  type CreateTableCommandInput,
  DescribeTableCommand,
  type DescribeTableCommandOutput,
  ResourceNotFoundException,
  UpdateTableCommand,
  type UpdateTableCommandInput,
} from "@aws-sdk/client-dynamodb";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

// Real commands and errors; only the client's network call (`send`) is faked.
vi.mock("@aws-sdk/client-dynamodb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-dynamodb")>();

  class FakeDynamoDBClient {
    send = send;
  }

  return { ...actual, DynamoDBClient: FakeDynamoDBClient };
});

const TABLE_NAME = "digital-downloads-main";

let init: typeof import("./dynamodb-init");

beforeAll(async () => {
  // The module runs initializeDynamoDB() when imported; make that import-time run a no-op.
  vi.stubEnv("DYNAMODB_MAIN_TABLE_NAME", "");
  vi.spyOn(console, "error").mockImplementation(() => {});

  init = await import("./dynamodb-init");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.stubEnv("DYNAMODB_MAIN_TABLE_NAME", TABLE_NAME);
  vi.stubEnv("AWS_REGION", "eu-west-1");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type FakeResponses = {
  describe: () => Promise<Partial<DescribeTableCommandOutput>>;
  create?: () => Promise<unknown>;
  update?: () => Promise<unknown>;
};

const fakeDynamo = (responses: FakeResponses) => {
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof DescribeTableCommand) return responses.describe();
    if (command instanceof CreateTableCommand && responses.create) return responses.create();
    if (command instanceof UpdateTableCommand && responses.update) return responses.update();

    throw new Error(`Unexpected DynamoDB command: ${String(command)}`);
  });
};

const sentInputs = <T>(CommandClass: abstract new (...args: never[]) => { input: T }) =>
  send.mock.calls
    .map(([command]: unknown[]) => command)
    .filter((command): command is { input: T } => command instanceof CommandClass)
    .map((command) => command.input);

const existingTable = (table: Partial<NonNullable<DescribeTableCommandOutput["Table"]>> = {}) =>
  Promise.resolve({
    Table: {
      TableName: TABLE_NAME,
      TableStatus: "ACTIVE" as const,
      ...table,
    },
  });

const ORDER_INDEX_PROVISIONED = {
  IndexName: "OrderIndex",
  KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }],
  Projection: { ProjectionType: "ALL" },
  ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
};

describe("dynamodb-init", () => {
  it("creates a missing table together with the OrderIndex GSI", async () => {
    fakeDynamo({
      describe: () =>
        Promise.reject(new ResourceNotFoundException({ message: "not found", $metadata: {} })),
      create: () => Promise.resolve({}),
    });

    await init.initializeDynamoDB();

    const creates = sentInputs<CreateTableCommandInput>(CreateTableCommand);

    expect(creates).toHaveLength(1);
    expect(creates[0].TableName).toBe(TABLE_NAME);
    expect(creates[0].KeySchema).toStrictEqual([
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ]);
    expect(creates[0].AttributeDefinitions).toContainEqual({
      AttributeName: "orderId",
      AttributeType: "S",
    });
    expect(creates[0].GlobalSecondaryIndexes).toStrictEqual([ORDER_INDEX_PROVISIONED]);
    expect(sentInputs(UpdateTableCommand)).toHaveLength(0);
  });

  it("adds the OrderIndex GSI to an existing provisioned table that lacks it", async () => {
    fakeDynamo({ describe: () => existingTable(), update: () => Promise.resolve({}) });

    await init.initializeDynamoDB();

    expect(sentInputs(CreateTableCommand)).toHaveLength(0);
    expect(sentInputs<UpdateTableCommandInput>(UpdateTableCommand)).toStrictEqual([
      {
        TableName: TABLE_NAME,
        AttributeDefinitions: [{ AttributeName: "orderId", AttributeType: "S" }],
        GlobalSecondaryIndexUpdates: [{ Create: ORDER_INDEX_PROVISIONED }],
      },
    ]);
  });

  it("omits provisioned throughput for an on-demand (PAY_PER_REQUEST) table", async () => {
    fakeDynamo({
      describe: () => existingTable({ BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" } }),
      update: () => Promise.resolve({}),
    });

    await init.initializeDynamoDB();

    const [update] = sentInputs<UpdateTableCommandInput>(UpdateTableCommand);
    const create = update?.GlobalSecondaryIndexUpdates?.[0]?.Create;

    expect(create?.IndexName).toBe("OrderIndex");
    expect(create).not.toHaveProperty("ProvisionedThroughput");
  });

  it("is idempotent: does nothing when the table and OrderIndex already exist", async () => {
    fakeDynamo({
      describe: () =>
        existingTable({
          GlobalSecondaryIndexes: [{ IndexName: "OrderIndex", IndexStatus: "CREATING" }],
        }),
    });

    await init.initializeDynamoDB();

    expect(sentInputs(CreateTableCommand)).toHaveLength(0);
    expect(sentInputs(UpdateTableCommand)).toHaveLength(0);
  });

  it("does not throw when adding the GSI fails (startup must not crash)", async () => {
    fakeDynamo({
      describe: () => existingTable(),
      update: () => Promise.reject(new Error("ResourceInUseException")),
    });

    await expect(init.initializeDynamoDB()).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to add OrderIndex"),
      expect.any(Error),
    );
  });

  it("does not throw when DynamoDB is unreachable", async () => {
    fakeDynamo({ describe: () => Promise.reject(new Error("connect ECONNREFUSED")) });

    await expect(init.initializeDynamoDB()).resolves.toBeUndefined();

    expect(sentInputs(CreateTableCommand)).toHaveLength(0);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to initialize DynamoDB"),
      expect.any(Error),
    );
  });
});
