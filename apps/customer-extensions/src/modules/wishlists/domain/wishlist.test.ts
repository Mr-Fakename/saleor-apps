import { describe, expect, it } from "vitest";

import { Wishlist } from "./wishlist";
import { createUserId } from "./types";

describe("Wishlist", () => {
  const validUserId = createUserId("user_123");

  describe("create", () => {
    it("should create a valid wishlist", () => {
      const result = Wishlist.create({
        userId: validUserId,
        name: "My Favorites",
      });

      expect(result.isOk()).toBe(true);

      if (result.isOk()) {
        const wishlist = result.value;
        expect(wishlist.userId).toBe(validUserId);
        expect(wishlist.name).toBe("My Favorites");
        expect(wishlist.id).toBeDefined();
        expect(wishlist.createdAt).toBeInstanceOf(Date);
        expect(wishlist.modifiedAt).toBeInstanceOf(Date);
      }
    });

    it("should trim whitespace from name", () => {
      const result = Wishlist.create({
        userId: validUserId,
        name: "  My Favorites  ",
      });

      expect(result.isOk()).toBe(true);

      if (result.isOk()) {
        expect(result.value.name).toBe("My Favorites");
      }
    });

    it("should return error for empty name", () => {
      const result = Wishlist.create({
        userId: validUserId,
        name: "",
      });

      expect(result.isErr()).toBe(true);

      if (result.isErr()) {
        expect(result.error.message).toContain("cannot be empty");
      }
    });

    it("should return error for name exceeding 100 characters", () => {
      const longName = "a".repeat(101);
      const result = Wishlist.create({
        userId: validUserId,
        name: longName,
      });

      expect(result.isErr()).toBe(true);

      if (result.isErr()) {
        expect(result.error.message).toContain("cannot exceed 100 characters");
      }
    });

    it("should accept name with exactly 100 characters", () => {
      const maxName = "a".repeat(100);
      const result = Wishlist.create({
        userId: validUserId,
        name: maxName,
      });

      expect(result.isOk()).toBe(true);
    });

    it("should accept name with 1 character", () => {
      const result = Wishlist.create({
        userId: validUserId,
        name: "A",
      });

      expect(result.isOk()).toBe(true);
    });
  });

  describe("fromDatabase", () => {
    it("should create wishlist from database data", () => {
      const now = new Date();
      const wishlist = Wishlist.fromDatabase({
        id: "wl_123" as any,
        userId: validUserId,
        name: "Test Wishlist",
        createdAt: now,
        modifiedAt: now,
      });

      expect(wishlist.id).toBe("wl_123");
      expect(wishlist.userId).toBe(validUserId);
      expect(wishlist.name).toBe("Test Wishlist");
      expect(wishlist.createdAt).toBe(now);
      expect(wishlist.modifiedAt).toBe(now);
    });
  });

  describe("toDatabase", () => {
    it("should serialize wishlist for database storage", () => {
      const result = Wishlist.create({
        userId: validUserId,
        name: "My Wishlist",
      });

      expect(result.isOk()).toBe(true);

      if (result.isOk()) {
        const dbData = result.value.toDatabase();

        expect(dbData).toEqual({
          id: result.value.id,
          userId: result.value.userId,
          name: "My Wishlist",
          createdAt: result.value.createdAt,
          modifiedAt: result.value.modifiedAt,
        });
      }
    });
  });
});
