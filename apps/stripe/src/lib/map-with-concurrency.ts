/**
 * Like `Promise.all(items.map(fn))`, but with at most `limit` calls of `fn` running at a time.
 * Results keep the order of `items`. Rejects as soon as one call rejects, like Promise.all.
 */
export const mapWithConcurrency = async <T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;

      nextIndex += 1;
      results[index] = await fn(items[index]);
    }
  };

  const workerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(Array.from({ length: workerCount }, worker));

  return results;
};
