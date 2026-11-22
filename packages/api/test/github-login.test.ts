import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClqnClient } from '@clqn/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { WorkspaceDb } from '../src/access.js';
import { createGithubLoginRoutes, githubRequest, verifiedIdentity } from '../src/github-login.js';
import { createStore } from '../src/store.js';

test('GitHub identity requires stable ID and verified primary email', () => {
  assert.deepEqual(
    verifiedIdentity({ id: 123, login: 'renameable' }, [{ email: 'A@example.com', primary: true, verified: true }]),
    { githubId: '123', email: 'a@example.com' },
  );
  for (const emails of [
    [],
    [{ email: 'a@example.com', primary: true, verified: false }],
    [{ email: 'a@example.com', primary: false, verified: true }],
  ]) {
    assert.throws(() => verifiedIdentity({ id: 123 }, emails));
  }
  assert.throws(() => verifiedIdentity({ id: '123' }, []));
});
test('GitHub transport redacts upstream errors and refuses redirects', async () => {
  await assert.rejects(
    githubRequest('/user', undefined, 'sensitive', async (_url, options) => {
      assert.equal(options?.redirect, 'error');
      throw new Error('sensitive upstream payload');
    }),
    { message: 'GitHub authentication unavailable' },
  );
  assert.throws(() => new ClqnClient('http://example.com').startGithubLogin(), /HTTPS/);
});
test('GitHub routes disabled by default and reject invalid input', async () => {
  const disabled = createGithubLoginRoutes();
  assert.equal((await disabled.request('/start', { method: 'POST' })).status, 503);
  const app = createGithubLoginRoutes({} as WorkspaceDb, 'id');
  const response = await app.request('/poll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"handle":"bad"}',
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('GitHub login limits starts per client, so one client cannot lock out others', async () => {
  const app = createGithubLoginRoutes();
  // The last X-Forwarded-For entry is the address Cloud Run observed; earlier entries are spoofable.
  const start = (forwarded: string) =>
    app.request('/start', { method: 'POST', headers: { 'x-forwarded-for': forwarded } });
  for (let i = 0; i < 10; i++) assert.equal((await start(`198.51.100.${i}, 192.0.2.1`)).status, 503);
  const limited = await start('192.0.2.1');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await start('192.0.2.2')).status, 503);
});
test('PostgreSQL: GitHub single use, concurrent completion, identity conflicts, throttling and revocation', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const sql = postgres(process.env.TEST_DATABASE_URL!);
  const connection = createStore(process.env.TEST_DATABASE_URL!);
  const ids: string[] = [];
  const handles: string[] = [];
  t.after(async () => {
    for (const handle of handles)
      await sql`delete from github_logins where handle_hash = encode(sha256(${handle}::bytea), 'hex')`;
    for (const id of ids) {
      await sql`delete from credentials where user_id = ${id}`;
      await sql`delete from users where id = ${id}`;
    }
    await connection.close();
    await sql.end();
  });
  await migrate(drizzle(sql), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  let email = `${randomUUID()}@example.com`;
  let githubId = Math.floor(Math.random() * 1e12) + 1;
  let polls = 0;
  let mode = 'complete';
  let gate: Promise<void> | undefined;
  const app = createGithubLoginRoutes(connection.db, 'client', async (path, body, token) => {
    if (path === '/login/device/code') {
      assert.equal(body?.scope, 'user:email');
      return {
        device_code: 'private-device-code',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      };
    }
    if (path === '/login/oauth/access_token') {
      polls++;
      await gate;
      return mode === 'complete' ? { access_token: 'private-github-token', token_type: 'bearer' } : { error: mode };
    }
    assert.equal(token, 'private-github-token');
    return path === '/user' ? { id: githubId } : [{ email, primary: true, verified: true }];
  });
  const post = async (path: string, body: object = {}) =>
    (
      await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json();
  const start = async () => {
    const attempt = await post('/start');
    handles.push(attempt.handle);
    return attempt;
  };
  const ready = async (handle: string) =>
    sql`update github_logins set next_poll_at = now() - interval '1 second' where handle_hash = encode(sha256(${handle}::bytea), 'hex')`;
  const first = await start();
  assert.equal(JSON.stringify(first).includes('private-device-code'), false);
  assert.equal((await post('/poll', { handle: first.handle })).status, 'pending');
  assert.equal(polls, 0);
  await ready(first.handle);
  // A slow GitHub response must not hold a lock: a concurrent poll returns immediately instead of waiting.
  let open: (() => void) | undefined;
  gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const inFlight = post('/poll', { handle: first.handle });
  while (polls === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await post('/poll', { handle: first.handle })).status, 'pending');
  open?.();
  gate = undefined;
  const complete = await inFlight;
  assert.equal(complete.status, 'complete');
  assert.equal(polls, 1);
  assert.equal((await post('/poll', { handle: first.handle })).status, 'expired');
  ids.push(complete.user.id);
  assert.equal(
    (await connection.store.authenticate((await import('../src/store.js')).hashToken(complete.token)))?.id,
    complete.user.id,
  );
  const [credential] = await sql`select id from credentials where user_id = ${complete.user.id}`;
  await connection.revokeCredential(credential!.id);
  assert.equal(
    await connection.store.authenticate((await import('../src/store.js')).hashToken(complete.token)),
    undefined,
  );
  const second = await start();
  const third = await start();
  await ready(second.handle);
  await ready(third.handle);
  const repeat = await Promise.all([post('/poll', { handle: second.handle }), post('/poll', { handle: third.handle })]);
  assert.deepEqual(
    repeat.map((result) => result.user.id),
    [complete.user.id, complete.user.id],
  );
  email = `${randomUUID()}@example.com`;
  const changed = await start();
  await ready(changed.handle);
  assert.equal((await post('/poll', { handle: changed.handle })).status, 'account_conflict');
  // A different identity with a matching operator email must never gain that account.
  const operator = await connection.provisionUser(email);
  ids.push(operator.user.id);
  const other = createGithubLoginRoutes(connection.db, 'client', async (path) =>
    path === '/login/device/code'
      ? {
          device_code: 'd',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }
      : path === '/login/oauth/access_token'
        ? { access_token: 't', token_type: 'bearer' }
        : path === '/user'
          ? { id: githubId + 1 }
          : [{ email, primary: true, verified: true }],
  );
  const a = await (await other.request('/start', { method: 'POST' })).json();
  handles.push(a.handle);
  await ready(a.handle);
  const conflict = await (
    await other.request('/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: a.handle }),
    })
  ).json();
  assert.equal(conflict.status, 'account_conflict');
  githubId += 2;
  email = `${randomUUID()}@example.com`;
  const concurrent = await Promise.all([start(), start()]);
  for (const attempt of concurrent) await ready(attempt.handle);
  const created = await Promise.all(concurrent.map((attempt) => post('/poll', { handle: attempt.handle })));
  assert.equal(created[0].status, 'complete');
  assert.equal(created[0].user.id, created[1].user.id);
  ids.push(created[0].user.id);
  mode = 'access_denied';
  const denied = await start();
  await ready(denied.handle);
  assert.equal((await post('/poll', { handle: denied.handle })).status, 'denied');
  assert.equal((await post('/poll', { handle: denied.handle })).status, 'expired');
  mode = 'slow_down';
  const slow = await start();
  await ready(slow.handle);
  assert.equal((await post('/poll', { handle: slow.handle })).interval, 10);
  await sql`update github_logins set expires_at = now() - interval '1 second' where handle_hash = encode(sha256(${slow.handle}::bytea), 'hex')`;
  assert.equal((await post('/poll', { handle: slow.handle })).status, 'expired');
});
