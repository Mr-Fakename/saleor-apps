// Next.js instrumentation hook: `register` runs once when the server starts
// (both `next start` and the standalone server.js). Use `process.env` here —
// importing an env module would break the Next.js build.

export const register = async () => {
  // Create the DynamoDB table if it is missing (replaces the former public
  // /api/setup-db route). Opt-in, like apps/digital-downloads.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.INIT_DYNAMODB_ON_STARTUP === "true") {
    const { initializeDynamoDB } = await import("./instrumentations/dynamodb-init");

    await initializeDynamoDB();
  }
};
