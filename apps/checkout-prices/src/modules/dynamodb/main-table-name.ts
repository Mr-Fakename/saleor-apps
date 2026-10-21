export const DEFAULT_MAIN_TABLE_NAME = "checkout-prices-main-table";

/**
 * Name of the app's single DynamoDB table (APL + config). One resolver for
 * the APL (dynamo-main-table.ts) and the startup initializer
 * (instrumentations/dynamodb-init.ts) so they can never disagree.
 */
export function resolveMainTableName(): string {
  return (
    process.env.DYNAMODB_MAIN_TABLE_NAME || process.env.CHECKOUT_PRICES_DYNAMODB_TABLE || DEFAULT_MAIN_TABLE_NAME
  );
}
