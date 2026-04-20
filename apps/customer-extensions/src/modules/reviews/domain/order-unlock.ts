import { err, ok, Result } from "neverthrow";

import { BaseError } from "@/lib/errors";

/**
 * Represents an unlocked order that allows reviews to be submitted.
 * Immutable domain entity with validation.
 */
export class OrderUnlock {
  static ValidationError = BaseError.subclass("OrderUnlockValidationError", {
    props: { _brand: "OrderUnlock.ValidationError" as const },
  });

  readonly orderId: string;
  readonly orderNumber: string; // Human-readable order number
  readonly customerEmail: string; // Denormalized for display
  readonly unlockedAt: Date; // When the order was unlocked
  readonly unlockedById: string; // Staff user ID who unlocked
  readonly unlockedByEmail: string; // Staff email who unlocked
  readonly createdAt: Date;
  readonly modifiedAt: Date;

  private constructor(
    orderId: string,
    orderNumber: string,
    customerEmail: string,
    unlockedAt: Date,
    unlockedById: string,
    unlockedByEmail: string,
    createdAt: Date,
    modifiedAt: Date
  ) {
    this.orderId = orderId;
    this.orderNumber = orderNumber;
    this.customerEmail = customerEmail;
    this.unlockedAt = unlockedAt;
    this.unlockedById = unlockedById;
    this.unlockedByEmail = unlockedByEmail;
    this.createdAt = createdAt;
    this.modifiedAt = modifiedAt;
  }

  /**
   * Creates a new OrderUnlock instance
   */
  static create(args: {
    orderId: string;
    orderNumber: string;
    customerEmail: string;
    unlockedById: string;
    unlockedByEmail: string;
  }): Result<OrderUnlock, InstanceType<typeof OrderUnlock.ValidationError>> {
    // Validate orderId
    if (!args.orderId || args.orderId.trim().length === 0) {
      return err(
        new this.ValidationError("Order ID cannot be empty", {
          props: { field: "orderId", value: args.orderId },
        })
      );
    }

    // Validate orderNumber
    if (!args.orderNumber || args.orderNumber.trim().length === 0) {
      return err(
        new this.ValidationError("Order number cannot be empty", {
          props: { field: "orderNumber", value: args.orderNumber },
        })
      );
    }

    // Validate customerEmail
    if (!args.customerEmail || !args.customerEmail.includes("@")) {
      return err(
        new this.ValidationError("Invalid customer email format", {
          props: { field: "customerEmail", value: args.customerEmail },
        })
      );
    }

    // Validate unlockedById
    if (!args.unlockedById || args.unlockedById.trim().length === 0) {
      return err(
        new this.ValidationError("Staff user ID cannot be empty", {
          props: { field: "unlockedById", value: args.unlockedById },
        })
      );
    }

    // Validate unlockedByEmail
    if (!args.unlockedByEmail || !args.unlockedByEmail.includes("@")) {
      return err(
        new this.ValidationError("Invalid staff email format", {
          props: { field: "unlockedByEmail", value: args.unlockedByEmail },
        })
      );
    }

    const now = new Date();

    return ok(
      new OrderUnlock(
        args.orderId.trim(),
        args.orderNumber.trim(),
        args.customerEmail.trim(),
        now,
        args.unlockedById.trim(),
        args.unlockedByEmail.trim(),
        now,
        now
      )
    );
  }

  /**
   * Creates an OrderUnlock instance from database data
   * Used by repository when loading from DynamoDB
   */
  static fromDatabase(data: {
    orderId: string;
    orderNumber: string;
    customerEmail: string;
    unlockedAt: Date;
    unlockedById: string;
    unlockedByEmail: string;
    createdAt: Date;
    modifiedAt: Date;
  }): OrderUnlock {
    return new OrderUnlock(
      data.orderId,
      data.orderNumber,
      data.customerEmail,
      data.unlockedAt,
      data.unlockedById,
      data.unlockedByEmail,
      data.createdAt,
      data.modifiedAt
    );
  }

  /**
   * Serializes the order unlock for storage
   */
  toDatabase() {
    return {
      orderId: this.orderId,
      orderNumber: this.orderNumber,
      customerEmail: this.customerEmail,
      unlockedAt: this.unlockedAt,
      unlockedById: this.unlockedById,
      unlockedByEmail: this.unlockedByEmail,
      createdAt: this.createdAt,
      modifiedAt: this.modifiedAt,
    };
  }
}
