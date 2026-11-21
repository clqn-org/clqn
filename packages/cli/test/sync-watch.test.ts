import assert from 'node:assert/strict';
import test from 'node:test';
import type { MainSyncResult } from '../src/git.js';
import { runSyncWatch, type SyncWatchOptions } from '../src/sync-watch.js';

const result = (status: MainSyncResult['status'] = 'unchanged'): MainSyncResult => ({
  repository: 'owner/project',
  path: '/fixture',
  branch: 'main' as const,
  status,
  previousSha: 'a'.repeat(40),
  headSha: 'a'.repeat(40),
  remoteSha: 'a'.repeat(40),
  ...(status === 'skipped' ? { reason: 'dirty' as const } : {}),
});
const event = (sequence: number, resourceId: string | null = 'owner/project', type = 'repository.main_changed') => ({
  sequence,
  resourceId,
  type,
});

function setup(overrides: Partial<SyncWatchOptions> = {}) {
  const controller = new AbortController();
  const errors: unknown[] = [];
  const results: MainSyncResult[] = [];
  const calls: object[] = [];
  return {
    controller,
    errors,
    results,
    calls,
    options: {
      repository: 'owner/project',
      repoPath: '/fixture',
      signal: controller.signal,
      pollIntervalMs: 10,
      fallbackIntervalMs: 1000,
      sync: async (input: object) => {
        calls.push(input);
        return result();
      },
      onError: (error: unknown) => errors.push(error),
      onResult: (value: MainSyncResult) => results.push(value),
      ...overrides,
    },
  };
}

test('event watcher performs startup sync but does not fetch Git for empty or unrelated API polls', {
  timeout: 2000,
}, async () => {
  const f = setup();
  let polls = 0;
  const cursors: number[] = [];
  await runSyncWatch({
    ...f.options,
    getEvents: async (cursor, signal) => {
      assert.equal(signal, f.controller.signal);
      cursors.push(cursor);
      polls += 1;
      if (polls === 4) f.controller.abort();
      return {
        events: [event(polls, 'another/repo'), event(polls + 10, 'owner/project', 'task.created')],
        nextCursor: polls + 10,
      };
    },
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.results.length, 1);
  assert.equal(f.errors.length, 0);
  assert.deepEqual(cursors, [0, 11, 12, 13]);
});

test('matching changes across event pages are coalesced into one Git sync and acknowledged together', {
  timeout: 2000,
}, async () => {
  const f = setup();
  const cursors: number[] = [];
  await runSyncWatch({
    ...f.options,
    getEvents: async (cursor) => {
      cursors.push(cursor);
      if (cursor === 0)
        return {
          events: Array.from({ length: 100 }, (_, index) =>
            event(index + 1, index === 30 ? 'OWNER/PROJECT' : 'another/repo'),
          ),
          nextCursor: 100,
        };
      if (cursor === 100) return { events: [event(101), event(102)], nextCursor: 102 };
      assert.equal(cursor, 102);
      f.controller.abort();
      return { events: [], nextCursor: cursor };
    },
  });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(cursors, [0, 100, 102]);
  assert.equal(f.errors.length, 0);
});

test('a failed Git notification sync retains its cursor and retries with backoff', { timeout: 2000 }, async () => {
  const f = setup();
  const cursors: number[] = [];
  const attempts: number[] = [];
  let count = 0;
  await runSyncWatch({
    ...f.options,
    sync: async (input) => {
      f.calls.push(input);
      attempts.push(Date.now());
      count += 1;
      if (count === 2 || count === 3) throw new Error('temporary Git failure');
      return result();
    },
    getEvents: async (cursor) => {
      cursors.push(cursor);
      if (cursor === 1) f.controller.abort();
      return cursor === 0 ? { events: [event(1)], nextCursor: 1 } : { events: [], nextCursor: cursor };
    },
  });
  assert.equal(f.calls.length, 4);
  assert.equal(f.errors.length, 2);
  assert.ok(cursors.filter((cursor) => cursor === 0).length >= 3);
  assert.equal(cursors.at(-1), 1);
  assert.ok(attempts[3]! - attempts[2]! >= 18, 'second failure backs off beyond one poll');
});

test('skipped dirty main is acknowledged and retried only at fallback, not on every API poll', {
  timeout: 2000,
}, async () => {
  const f = setup();
  let polls = 0;
  await runSyncWatch({
    ...f.options,
    sync: async (input) => {
      f.calls.push(input);
      return result(f.calls.length === 1 ? 'unchanged' : 'skipped');
    },
    getEvents: async (cursor) => {
      polls += 1;
      if (polls === 4) f.controller.abort();
      return cursor === 0 ? { events: [event(1)], nextCursor: 1 } : { events: [], nextCursor: cursor };
    },
  });
  assert.equal(f.calls.length, 2);
  assert.equal(f.results[1]?.reason, 'dirty');
  assert.equal(f.errors.length, 0);
});

test('API errors back off without starving the slow Git fallback', { timeout: 2000 }, async () => {
  const f = setup({ fallbackIntervalMs: 35 });
  let polls = 0;
  await runSyncWatch({
    ...f.options,
    sync: async (input) => {
      f.calls.push(input);
      if (f.calls.length === 3) f.controller.abort();
      return result();
    },
    getEvents: async () => {
      polls += 1;
      throw new Error('API unavailable');
    },
  });
  assert.equal(f.calls.length, 3);
  assert.ok(polls >= 3);
  assert.equal(f.errors.length, polls);
});

test('startup Git failures recover while event polling continues', { timeout: 2000 }, async () => {
  const f = setup();
  let attempts = 0;
  let polls = 0;
  await runSyncWatch({
    ...f.options,
    sync: async (input) => {
      f.calls.push(input);
      attempts += 1;
      if (attempts < 3) throw new Error('startup network failure');
      return result();
    },
    getEvents: async (cursor) => {
      polls += 1;
      if (polls === 6) f.controller.abort();
      return { events: [], nextCursor: cursor };
    },
  });
  assert.equal(f.calls.length, 3);
  assert.equal(f.errors.length, 2);
  assert.equal(f.results.length, 1);
});

test('local-only mode performs startup and slow fallback syncs without an event client', {
  timeout: 2000,
}, async () => {
  const f = setup({ fallbackIntervalMs: 25 });
  const times: number[] = [];
  await runSyncWatch({
    ...f.options,
    sync: async (input) => {
      f.calls.push(input);
      times.push(Date.now());
      if (f.calls.length === 3) f.controller.abort();
      return result();
    },
  });
  assert.equal(f.calls.length, 3);
  assert.ok(times[1]! - times[0]! >= 24);
  assert.ok(times[2]! - times[1]! >= 24);
});

test('cancellation stops an outstanding event read promptly', { timeout: 2000 }, async () => {
  const f = setup();
  const timer = setTimeout(() => f.controller.abort(), 30);
  try {
    await runSyncWatch({ ...f.options, getEvents: async () => new Promise(() => {}) });
  } finally {
    clearTimeout(timer);
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.errors.length, 0);
});

test('busy event logs are bounded per tick and malformed cursors do not cause a hot loop', {
  timeout: 2000,
}, async () => {
  const f = setup();
  let pages = 0;
  const times: number[] = [];
  await runSyncWatch({
    ...f.options,
    getEvents: async (cursor) => {
      pages += 1;
      times.push(Date.now());
      if (pages === 11) {
        f.controller.abort();
        return { events: [], nextCursor: cursor };
      }
      return {
        events: Array.from({ length: 100 }, (_, index) => event(cursor + index + 1, 'another/repo')),
        nextCursor: cursor + 100,
      };
    },
  });
  assert.equal(pages, 11);
  assert.ok(times[10]! - times[9]! >= 9);
  const invalid = setup();
  await runSyncWatch({
    ...invalid.options,
    getEvents: async () => {
      if (invalid.errors.length) invalid.controller.abort();
      return { events: [event(1)], nextCursor: 0 };
    },
  });
  assert.equal(invalid.errors.length, 1);
  assert.equal(invalid.calls.length, 1);
});

test('invalid timing and cursor configuration fails before syncing', async () => {
  for (const overrides of [{ pollIntervalMs: 0 }, { fallbackIntervalMs: NaN }, { initialCursor: -1 }]) {
    const f = setup(overrides);
    await assert.rejects(runSyncWatch(f.options));
    assert.equal(f.calls.length, 0);
  }
});
