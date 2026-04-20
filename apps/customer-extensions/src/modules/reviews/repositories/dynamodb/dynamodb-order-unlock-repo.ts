import { DeleteItemCommand, GetItemCommand, PutItemCommand } from "dynamodb-toolbox";
import { QueryCommand } from "dynamodb-toolbox/table/actions/query";
import { err, ok, Result } from "neverthrow";

import { createLogger } from "@/lib/logger";

import { OrderUnlock } from "../../domain/order-unlock";
import { BaseAccessPattern, OrderUnlockRepo, OrderUnlockRepoError } from "../order-unlock-repo";
import { DynamoDbOrderUnlock, DynamoDbOrderUnlockEntity } from "./order-unlock-db-model";

type ConstructorParams = {
  entities: {
    orderUnlock: DynamoDbOrderUnlockEntity;
  };
};

export class DynamodbOrderUnlockRepo implements OrderUnlockRepo {
  private logger = createLogger("DynamodbOrderUnlockRepo");

  orderUnlockEntity: DynamoDbOrderUnlockEntity;

  constructor(
    config: ConstructorParams = {
      entities: {
        orderUnlock: DynamoDbOrderUnlock.entity,
      },
    }
  ) {
    this.orderUnlockEntity = config.entities.orderUnlock;
  }

  async unlockOrder(
    access: BaseAccessPattern,
    orderUnlock: OrderUnlock
  ): Promise<Result<null, InstanceType<typeof OrderUnlockRepoError.FailureSavingUnlock>>> {
    try {
      const dbData = orderUnlock.toDatabase();

      await this.orderUnlockEntity
        .build(PutItemCommand)
        .item({
          PK: DynamoDbOrderUnlock.accessPattern.getPK(),
          SK: DynamoDbOrderUnlock.accessPattern.getSKforSpecificOrder({
            orderId: dbData.orderId,
          }),
          orderId: dbData.orderId,
          orderNumber: dbData.orderNumber,
          customerEmail: dbData.customerEmail,
          unlockedAt: dbData.unlockedAt.toISOString(),
          unlockedById: dbData.unlockedById,
          unlockedByEmail: dbData.unlockedByEmail,
          createdAt: dbData.createdAt.toISOString(),
          modifiedAt: dbData.modifiedAt.toISOString(),
        })
        .send();

      this.logger.debug("Order unlocked successfully", { orderId: dbData.orderId });

      return ok(null);
    } catch (error) {
      this.logger.error("Failed to unlock order", { error, orderId: orderUnlock.orderId });
      return err(
        new OrderUnlockRepoError.FailureSavingUnlock("Failed to unlock order", {
          cause: error,
        })
      );
    }
  }

  async isOrderUnlocked(
    access: BaseAccessPattern,
    orderId: string
  ): Promise<Result<boolean, InstanceType<typeof OrderUnlockRepoError.FailureFetchingUnlocks>>> {
    try {
      const result = await this.orderUnlockEntity
        .build(GetItemCommand)
        .key({
          PK: DynamoDbOrderUnlock.accessPattern.getPK(),
          SK: DynamoDbOrderUnlock.accessPattern.getSKforSpecificOrder({ orderId }),
        })
        .send();

      return ok(result.Item !== undefined);
    } catch (error) {
      this.logger.error("Failed to check order unlock status", { error, orderId });
      return err(
        new OrderUnlockRepoError.FailureFetchingUnlocks("Failed to check order unlock status", {
          cause: error,
        })
      );
    }
  }

  async getOrderUnlock(
    access: BaseAccessPattern,
    orderId: string
  ): Promise<
    Result<OrderUnlock | null, InstanceType<typeof OrderUnlockRepoError.FailureFetchingUnlocks>>
  > {
    try {
      const result = await this.orderUnlockEntity
        .build(GetItemCommand)
        .key({
          PK: DynamoDbOrderUnlock.accessPattern.getPK(),
          SK: DynamoDbOrderUnlock.accessPattern.getSKforSpecificOrder({ orderId }),
        })
        .send();

      if (!result.Item) {
        return ok(null);
      }

      const item = result.Item;

      return ok(
        OrderUnlock.fromDatabase({
          orderId: item.orderId,
          orderNumber: item.orderNumber,
          customerEmail: item.customerEmail,
          unlockedAt: new Date(item.unlockedAt),
          unlockedById: item.unlockedById,
          unlockedByEmail: item.unlockedByEmail,
          createdAt: new Date(item.createdAt),
          modifiedAt: new Date(item.modifiedAt),
        })
      );
    } catch (error) {
      this.logger.error("Failed to get order unlock", { error, orderId });
      return err(
        new OrderUnlockRepoError.FailureFetchingUnlocks("Failed to get order unlock", {
          cause: error,
        })
      );
    }
  }

  async getUnlockedOrders(
    access: BaseAccessPattern
  ): Promise<
    Result<OrderUnlock[], InstanceType<typeof OrderUnlockRepoError.FailureFetchingUnlocks>>
  > {
    try {
      this.logger.debug("Fetching all unlocked orders");

      const query = this.orderUnlockEntity.table
        .build(QueryCommand)
        .entities(this.orderUnlockEntity)
        .query({
          partition: DynamoDbOrderUnlock.accessPattern.getPK(),
        })
        .options({ maxPages: Infinity });

      const result = await query.send();

      const unlocks = (result.Items || []).map((item) =>
        OrderUnlock.fromDatabase({
          orderId: item.orderId,
          orderNumber: item.orderNumber,
          customerEmail: item.customerEmail,
          unlockedAt: new Date(item.unlockedAt),
          unlockedById: item.unlockedById,
          unlockedByEmail: item.unlockedByEmail,
          createdAt: new Date(item.createdAt),
          modifiedAt: new Date(item.modifiedAt),
        })
      );

      this.logger.debug(`Fetched ${unlocks.length} unlocked orders`);
      return ok(unlocks);
    } catch (error) {
      this.logger.error("Failed to fetch unlocked orders", { error });
      return err(
        new OrderUnlockRepoError.FailureFetchingUnlocks("Failed to fetch unlocked orders", {
          cause: error,
        })
      );
    }
  }

  async lockOrder(
    access: BaseAccessPattern,
    orderId: string
  ): Promise<Result<null, InstanceType<typeof OrderUnlockRepoError.FailureDeletingUnlock>>> {
    try {
      await this.orderUnlockEntity
        .build(DeleteItemCommand)
        .key({
          PK: DynamoDbOrderUnlock.accessPattern.getPK(),
          SK: DynamoDbOrderUnlock.accessPattern.getSKforSpecificOrder({ orderId }),
        })
        .send();

      this.logger.debug("Order locked successfully", { orderId });
      return ok(null);
    } catch (error) {
      this.logger.error("Failed to lock order", { error, orderId });
      return err(
        new OrderUnlockRepoError.FailureDeletingUnlock("Failed to lock order", {
          cause: error,
        })
      );
    }
  }
}

// Export singleton instance
export const dynamodbOrderUnlockRepo = new DynamodbOrderUnlockRepo();
