import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "./map-with-concurrency";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("mapWithConcurrency", () => {
  it("never runs more than `limit` calls at a time, and keeps the order of the items", async () => {
    let running = 0;
    let maxRunning = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await tick();
      running -= 1;

      return n * 10;
    });

    expect(results).toStrictEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(maxRunning).toBe(3);
  });

  it("returns an empty list for no items", async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toStrictEqual([]);
  });

  it("rejects when a call rejects", async () => {
    await expect(
      mapWithConcurrency([1, 2], 5, async (n) => {
        if (n === 2) {
          throw new Error("boom");
        }

        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
