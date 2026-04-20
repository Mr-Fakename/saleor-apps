import { attachLoggerConsoleTransport, rootLogger } from "@saleor/apps-logger";

rootLogger.settings.maskValuesOfKeys = ["metadata", "username", "password", "apiKey", "vatNumber"];

if (process.env.NODE_ENV !== "production") {
  attachLoggerConsoleTransport(rootLogger);
}

export const createLogger = (name: string, params?: Record<string, unknown>) =>
  rootLogger.getSubLogger({ name }, params);
