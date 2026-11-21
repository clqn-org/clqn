import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createRateLimiter } from '../src/rate-limit.js';
import type { WorkspaceStore } from '../src/store.js';

const alice = { id: '65fd2b48-b47f-4862-a85d-af491cdb8a3c', email: 'alice@example.com' };
const auth = (letter: string) => ({ authorization: `Bearer clqn_${letter.repeat(43)}` });

test('rate limiter counts each key per window and reports when to retry', () => {
  const limit = createRateLimiter(2, 60_000);
  assert.equal(limit('a', 0), undefined);
  assert.equal(limit('a', 1_000), undefined);
  assert.equal(limit('a', 1_500), 59);
  assert.equal(limit('b', 1_500), undefined);
  assert.equal(limit('a', 60_000), undefined);
});

test('rate limiter stops tracking new keys once full', () => {
  const limit = createRateLimiter(1, 60_000, 1);
  assert.equal(limit('a', 0), undefined);
  assert.equal(limit('a', 0), 60);
  assert.equal(limit('b', 0), undefined);
  assert.equal(limit('b', 0), undefined);
});

test('API rejects a credential over its limit before authenticating it', async () => {
  let lookups = 0;
  const store = {
    authenticate: async () => {
      lookups++;
      return alice;
    },
  } as Partial<WorkspaceStore> as WorkspaceStore;
  const app = createApp(store, undefined, { requestsPerMinute: 2 });
  assert.equal((await app.request('/v1/me', { headers: auth('a') })).status, 200);
  assert.equal((await app.request('/v1/me', { headers: auth('a') })).status, 200);
  const limited = await app.request('/v1/me', { headers: auth('a') });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.deepEqual(await limited.json(), {
    error: { code: 'RATE_LIMITED', message: 'Too many requests; try again later' },
  });
  assert.equal(lookups, 2);
  assert.equal((await app.request('/v1/me', { headers: auth('b') })).status, 200);
});
