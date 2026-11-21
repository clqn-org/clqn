import { type MainSyncResult, syncMain } from './git.js';

export interface SyncEventPage {
  events: Array<{ sequence: number; type: string; resourceId: string | null }>;
  nextCursor: number;
}

export interface SyncWatchOptions {
  repository: string;
  repoPath: string;
  signal: AbortSignal;
  pollIntervalMs?: number;
  fallbackIntervalMs?: number;
  initialCursor?: number;
  getEvents?: (cursor: number, signal?: AbortSignal) => Promise<SyncEventPage>;
  sync?: (input: { repoPath: string; repository: string; signal: AbortSignal }) => Promise<MainSyncResult>;
  onResult: (result: MainSyncResult) => void;
  onError: (error: unknown) => void;
}

const cancelled = Symbol('cancelled');

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(1, milliseconds));
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

async function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T | typeof cancelled> {
  if (signal.aborted) return cancelled;
  let stop: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<typeof cancelled>((resolve) => {
        stop = () => resolve(cancelled);
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      }),
    ]);
  } finally {
    if (stop) signal.removeEventListener('abort', stop);
  }
}

// Git runs at startup, after a matching notification, or on a slow safety fallback.
// An API poll is not itself a reason to contact GitHub over Git.
export async function runSyncWatch(options: SyncWatchOptions): Promise<void> {
  const pollInterval = options.pollIntervalMs ?? 15_000;
  const fallbackInterval = options.fallbackIntervalMs ?? 300_000;
  let cursor = options.initialCursor ?? 0;
  if (
    !Number.isFinite(pollInterval) ||
    pollInterval <= 0 ||
    !Number.isFinite(fallbackInterval) ||
    fallbackInterval <= 0
  ) {
    throw new Error('Sync intervals must be positive finite numbers');
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Sync cursor must be a nonnegative safe integer');
  const signal = options.signal;
  const sync = options.sync ?? syncMain;
  const repository = options.repository.toLowerCase();
  let pendingCursor: number | undefined;
  let gitFailures = 0;
  let apiFailures = 0;
  let nextGitAt = Date.now();
  let nextApiAt = Date.now();
  const backoff = (failures: number) => Math.min(fallbackInterval, pollInterval * 2 ** Math.min(failures - 1, 20));

  const synchronize = async () => {
    try {
      const result = await untilAborted(
        sync({ repoPath: options.repoPath, repository: options.repository, signal }),
        signal,
      );
      if (result === cancelled || signal.aborted) return;
      gitFailures = 0;
      nextGitAt = Date.now() + fallbackInterval;
      // A skipped local checkout is left untouched. Its next attempt is the safety fallback,
      // not a repeated network fetch on every lightweight API poll.
      if (pendingCursor !== undefined) {
        cursor = pendingCursor;
        pendingCursor = undefined;
      }
      options.onResult(result);
    } catch (error) {
      if (signal.aborted) return;
      gitFailures += 1;
      nextGitAt = Date.now() + backoff(gitFailures);
      options.onError(error);
    }
  };

  if (!signal.aborted) await synchronize();
  while (!signal.aborted) {
    if (options.getEvents && Date.now() >= nextApiAt) {
      try {
        let scannedCursor = cursor;
        let changed = false;
        // Bound work per tick so a busy clan cannot starve Git fallback or cancellation.
        for (let pages = 0; pages < 10 && !signal.aborted; pages += 1) {
          const page = await untilAborted(options.getEvents(scannedCursor, signal), signal);
          if (page === cancelled || signal.aborted) return;
          if (
            !Number.isSafeInteger(page.nextCursor) ||
            page.nextCursor < scannedCursor ||
            page.events.length > 100 ||
            (page.events.length > 0 && page.nextCursor === scannedCursor)
          ) {
            throw new Error('Event cursor did not advance correctly');
          }
          changed ||= page.events.some(
            (event) =>
              event.sequence > cursor &&
              event.type === 'repository.main_changed' &&
              event.resourceId?.toLowerCase() === repository,
          );
          scannedCursor = page.nextCursor;
          if (page.events.length < 100) break;
        }
        apiFailures = 0;
        nextApiAt = Date.now() + pollInterval;
        if (changed) {
          pendingCursor = Math.max(pendingCursor ?? 0, scannedCursor);
          // A failed Git operation retains its backoff, even if the same event is seen again.
          if (gitFailures === 0) nextGitAt = Date.now();
        } else if (pendingCursor === undefined) cursor = scannedCursor;
      } catch (error) {
        if (signal.aborted) return;
        apiFailures += 1;
        nextApiAt = Date.now() + backoff(apiFailures);
        options.onError(error);
      }
    }
    if (!signal.aborted && Date.now() >= nextGitAt) await synchronize();
    if (signal.aborted) break;
    const next = options.getEvents ? Math.min(nextApiAt, nextGitAt) : nextGitAt;
    await wait(next - Date.now(), signal);
  }
}
