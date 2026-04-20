import { Result } from "neverthrow";

import { BaseError } from "@/lib/errors";

import { OrderUnlock } from "../domain/order-unlock";

export type BaseAccessPattern = {
  saleorApiUrl: string;
  appId: string;
};

export const OrderUnlockRepoError = {
  FailureSavingUnlock: BaseError.subclass("FailureSavingUnlockError", {
    props: {
      _internalName: "OrderUnlockRepoError.FailureSavingUnlock",
    },
  }),
  FailureFetchingUnlocks: BaseError.subclass("FailureFetchingUnlocksError", {
    props: {
      _internalName: "OrderUnlockRepoError.FailureFetchingUnlocks",
    },
  }),
  FailureDeletingUnlock: BaseError.subclass("FailureDeletingUnlockError", {
    props: {
      _internalName: "OrderUnlockRepoError.FailureDeletingUnlock",
    },
  }),
  DuplicateUnlock: BaseError.subclass("DuplicateUnlockError", {
    props: {
      _internalName: "OrderUnlockRepoError.DuplicateUnlock",
    },
  }),
};

export interface OrderUnlockRepo {
  /**
   * Unlocks an order for reviews
   */
  unlockOrder: (
    access: BaseAccessPattern,
    orderUnlock: OrderUnlock
  ) => Promise<Result<null, InstanceType<typeof OrderUnlockRepoError.FailureSavingUnlock>>>;

  /**
   * Checks if a specific order is unlocked
   */
  isOrderUnlocked: (
    access: BaseAccessPattern,
    orderId: string
  ) => Promise<Result<boolean, InstanceType<typeof OrderUnlockRepoError.FailureFetchingUnlocks>>>;

  /**
   * Gets the unlock record for a specific order
   */
  getOrderUnlock: (
    access: BaseAccessPattern,
    orderId: string
  ) => Promise<
    Result<OrderUnlock | null, InstanceType<typeof OrderUnlockRepoError.FailureFetchingUnlocks>>
  >;

  /**
   * Gets all unlocked orders
   */
  getUnlockedOrders: (
    access: BaseAccessPattern
  ) => Promise<
    Result<OrderUnlock[], InstanceType<typeof OrderUnlockRepoError.FailureFetchingUnlocks>>
  >;

  /**
   * Removes the unlock (re-locks the order)
   */
  lockOrder: (
    access: BaseAccessPattern,
    orderId: string
  ) => Promise<Result<null, InstanceType<typeof OrderUnlockRepoError.FailureDeletingUnlock>>>;
}
