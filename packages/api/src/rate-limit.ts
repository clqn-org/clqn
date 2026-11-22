// A process-local, fixed-window request limit per key. Each API instance counts separately,
// so deployment-wide limits are up to the instance count times this limit.
export function createRateLimiter(limit: number, windowMs = 60_000, maxKeys = 10_000) {
  const counts = new Map<string, number>();
  let resetAt = 0;
  const roll = (now: number) => {
    if (now >= resetAt) {
      counts.clear();
      resetAt = now + windowMs;
    }
  };
  return {
    // Returns the seconds to wait when the key is over its limit. Checking does not count a request.
    retryAfter(key: string, now = Date.now()): number | undefined {
      roll(now);
      if ((counts.get(key) ?? 0) < limit) return undefined;
      return Math.max(1, Math.ceil((resetAt - now) / 1000));
    },
    record(key: string, now = Date.now()): void {
      roll(now);
      const count = counts.get(key);
      // Keep memory bounded: once the table is full, new keys pass untracked until the window resets.
      if (count === undefined && counts.size >= maxKeys) return;
      counts.set(key, (count ?? 0) + 1);
    },
  };
}
