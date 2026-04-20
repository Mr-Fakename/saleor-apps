import { err, ok, Result } from "neverthrow";

import { BaseError } from "@/lib/errors";

import { generateWishlistId, UserId, WishlistId } from "./types";

export class Wishlist {
  static ValidationError = BaseError.subclass("WishlistValidationError", {
    props: { _brand: "Wishlist.ValidationError" as const },
  });

  readonly id: WishlistId;
  readonly userId: UserId;
  readonly name: string;
  readonly createdAt: Date;
  readonly modifiedAt: Date;

  private constructor(
    id: WishlistId,
    userId: UserId,
    name: string,
    createdAt: Date,
    modifiedAt: Date
  ) {
    this.id = id;
    this.userId = userId;
    this.name = name;
    this.createdAt = createdAt;
    this.modifiedAt = modifiedAt;
  }

  static create(args: {
    userId: UserId;
    name: string;
  }): Result<Wishlist, InstanceType<typeof Wishlist.ValidationError>> {
    // Validate name length (1-100 characters)
    if (args.name.length < 1) {
      return err(
        new this.ValidationError("Wishlist name cannot be empty", {
          props: { field: "name", value: args.name },
        })
      );
    }

    if (args.name.length > 100) {
      return err(
        new this.ValidationError("Wishlist name cannot exceed 100 characters", {
          props: { field: "name", value: args.name, maxLength: 100 },
        })
      );
    }

    const now = new Date();

    return ok(
      new Wishlist(generateWishlistId(), args.userId, args.name.trim(), now, now)
    );
  }

  /**
   * Creates a Wishlist instance from database data
   * Used by repository when loading from DynamoDB
   */
  static fromDatabase(data: {
    id: WishlistId;
    userId: UserId;
    name: string;
    createdAt: Date;
    modifiedAt: Date;
  }): Wishlist {
    return new Wishlist(
      data.id,
      data.userId,
      data.name,
      data.createdAt,
      data.modifiedAt
    );
  }

  /**
   * Serializes the wishlist for storage
   */
  toDatabase() {
    return {
      id: this.id,
      userId: this.userId,
      name: this.name,
      createdAt: this.createdAt,
      modifiedAt: this.modifiedAt,
    };
  }
}
