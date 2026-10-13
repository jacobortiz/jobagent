/** Run `fn` over `items` with at most `limit` in flight. Preserves order of results. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry with exponential backoff. `shouldRetry` decides which errors are transient. */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; shouldRetry?: (err: unknown) => boolean } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 1000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || (opts.shouldRetry && !opts.shouldRetry(err))) throw err;
      await sleep(baseMs * 2 ** i);
    }
  }
  throw lastErr;
}
