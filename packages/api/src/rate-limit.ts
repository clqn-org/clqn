// A process-local, fixed-window request limit per key. Each API instance counts separately,
// so deployment-wide limits are up to the instance count times this limit.
export function createRateLimiter(limit: number, windowMs = 60_000, maxKeys = 10_000) {
  const counts = new Map<string, number>();
  let resetAt = 0;
  // Returns the seconds to wait when the key is over its limit.
  return (key: string, now = Date.now()): number | undefined => {
    if (now >= resetAt) {
      counts.clear();
      resetAt = now + windowMs;
    }
    const count = counts.get(key);
    // Keep memory bounded: once the table is full, new keys pass untracked until the window resets.
    if (count === undefined && counts.size >= maxKeys) return undefined;
    if (count !== undefined && count >= limit) return Math.max(1, Math.ceil((resetAt - now) / 1000));
    counts.set(key, (count ?? 0) + 1);
    return undefined;
  };
}
