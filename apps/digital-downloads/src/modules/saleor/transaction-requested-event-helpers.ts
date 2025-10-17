import {
  TransactionCancelationRequestedEventFragment,
  TransactionChargeRequestedEventFragment,
  TransactionRefundRequestedEventFragment,
} from "@/generated/graphql";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger("transaction-requested-event-helpers");

const MissingTransactionError = BaseError.subclass("MissingTransactionError", {
  props: {
    __internalName: "MissingTransactionError",
  },
});

const MissingChannelIdError = BaseError.subclass("MissingChannelIdError", {
  props: {
    __internalName: "MissingChannelIdError",
  },
});

/**
 * Additional helper as Saleor Graphql schema doesn't require transaction and it is needed to process the event
 */
export const getTransactionFromRequestedEventPayload = (
  event:
    | TransactionRefundRequestedEventFragment
    | TransactionChargeRequestedEventFragment
    | TransactionCancelationRequestedEventFragment,
) => {
  logger.debug("=== TRANSACTION HELPER DEBUG: Extracting transaction ===", {
    hasEvent: !!event,
    hasTransaction: !!event?.transaction,
    eventVersion: event?.version,
    transactionId: event?.transaction?.id,
    transactionPspReference: event?.transaction?.pspReference,
  });

  if (!event.transaction) {
    logger.error("=== TRANSACTION HELPER DEBUG: Transaction not found in event ===", {
      event,
      hasEvent: !!event,
      eventKeys: event ? Object.keys(event) : [],
    });
    throw new MissingTransactionError("Transaction not found in event");
  }

  logger.debug("=== TRANSACTION HELPER DEBUG: Transaction extracted successfully ===", {
    transactionId: event.transaction.id,
    pspReference: event.transaction.pspReference,
    hasCheckout: !!event.transaction.checkout,
    hasOrder: !!event.transaction.order,
  });

  return event.transaction;
};

/**
 *
 * Additional helper as Saleor Graphql schema doesn't require Order / Channel and it is needed to process the event
 */
export const getChannelIdFromRequestedEventPayload = (
  event:
    | TransactionRefundRequestedEventFragment
    | TransactionChargeRequestedEventFragment
    | TransactionCancelationRequestedEventFragment,
) => {
  logger.debug("=== CHANNEL HELPER DEBUG: Extracting channel ID ===", {
    hasEvent: !!event,
  });

  const transaction = getTransactionFromRequestedEventPayload(event);

  const possibleChannelId = transaction.checkout?.channel?.id || transaction.order?.channel?.id;

  logger.debug("=== CHANNEL HELPER DEBUG: Channel extraction attempt ===", {
    hasCheckout: !!transaction.checkout,
    hasOrder: !!transaction.order,
    checkoutChannelId: transaction.checkout?.channel?.id,
    orderChannelId: transaction.order?.channel?.id,
    resolvedChannelId: possibleChannelId,
  });

  if (!possibleChannelId) {
    logger.error("=== CHANNEL HELPER DEBUG: Channel ID not found ===", {
      transactionStructure: {
        hasCheckout: !!transaction.checkout,
        hasOrder: !!transaction.order,
        checkout: transaction.checkout,
        order: transaction.order,
      },
    });
    throw new MissingChannelIdError("Channel ID not found in event Checkout or Order");
  }

  logger.debug("=== CHANNEL HELPER DEBUG: Channel ID extracted successfully ===", {
    channelId: possibleChannelId,
  });

  return possibleChannelId;
};
