import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createStore } from '../dist/store.js';
import { createApp } from '../dist/app.js';
import { contextEntrySchema, contextHistorySchema, contextKeySchema, contextListSchema, writeContextSchema } from '@clqn/shared';

test('context contracts require optimistic revisions and bound UTF-8 text', () => {
  assert.equal(writeContextSchema.safeParse({ text: 'hello', expectedRevision: 0 }).success, true);
  assert.equal(contextKeySchema.safeParse('.').success, false);
  assert.equal(contextKeySchema.safeParse('..').success, false);
  for (const body of [{ text: 'hello' }, { text: '\0', expectedRevision: 0 }, { text: '', expectedRevision: -1 },
    { text: '', expectedRevision: 0, actorId: randomUUID() }, { text: '🎉'.repeat(16385), expectedRevision: 0 }]) {
    assert.equal(writeContextSchema.safeParse(body).success, false);
  }
});

test('PostgreSQL: context isolation, immutable revisions, and concurrent compare-and-set writes', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const sql = postgres(process.env.TEST_DATABASE_URL, { max: 2 });
  const connection = createStore(process.env.TEST_DATABASE_URL);
  const userIds = [];
  const clanIds = [];
  t.after(async () => {
    try {
      if (clanIds.length) {
        await sql`delete from context_revisions where clan_id in ${sql(clanIds)}`;
        await sql`delete from context_entries where clan_id in ${sql(clanIds)}`;
        await sql`delete from events where clan_id in ${sql(clanIds)}`;
        await sql`delete from memberships where clan_id in ${sql(clanIds)}`;
        await sql`delete from clans where id in ${sql(clanIds)}`;
      }
      if (userIds.length) {
        await sql`delete from credentials where user_id in ${sql(userIds)}`;
        await sql`delete from users where id in ${sql(userIds)}`;
      }
    } finally { await connection.close(); await sql.end(); }
  });
  await migrate(drizzle(sql), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const alice = await connection.provisionUser(`${randomUUID()}@example.com`);
  const bob = await connection.provisionUser(`${randomUUID()}@example.com`);
  userIds.push(alice.user.id, bob.user.id);
  const clan = await connection.store.createClan(alice.user.id, 'Context test');
  clanIds.push(clan.id);
  const app = createApp(connection.store, connection.db);
  const key = encodeURIComponent('project/notes with spaces');
  const path = `/v1/clans/${clan.id}/context/${key}`;
  const auth = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const write = (text, expectedRevision, token = alice.token) => app.request(path, {
    method: 'POST', headers: auth(token), body: JSON.stringify({ text, expectedRevision }),
  });
  assert.equal((await app.request(path, { headers: auth(alice.token) })).status, 404);
  const denied = await write('cannot write', 0, bob.token);
  assert.equal(denied.status, 404);
  assert.equal((await write('no entry yet', 1)).status, 404);
  const [first, race] = await Promise.all([write('original', 0), write('racing create', 0)]);
  assert.deepEqual([first.status, race.status].sort(), [201, 409]);
  const created = contextEntrySchema.parse(await (first.status === 201 ? first : race).json());
  assert.equal(created.key, decodeURIComponent(key));
  assert.equal(created.revision, 1);
  const revisions = await Promise.all([write('update A', 1), write('update B', 1)]);
  assert.deepEqual(revisions.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await write('stale', 1)).status, 409);
  assert.equal((await write('missing expected revision', undefined)).status, 400);
  const latestResponse = await app.request(path, { headers: auth(alice.token) });
  const latest = contextEntrySchema.parse(await latestResponse.json());
  assert.equal(latest.revision, 2);
  const history = contextHistorySchema.parse(await (await app.request(`${path}/history`, { headers: auth(alice.token) })).json());
  assert.deepEqual(history.revisions.map((entry) => entry.revision), [1, 2]);
  assert.equal(history.revisions[0].text, created.text);
  assert.equal(history.revisions[1].text, latest.text);
  const listing = contextListSchema.parse(await (await app.request(`/v1/clans/${clan.id}/context`, { headers: auth(alice.token) })).json());
  assert.equal(listing.entries[0].revision, 2);
  assert.equal((await app.request(`${path}/history`, { headers: auth(bob.token) })).status, 404);
  const [audit] = await sql`select count(*)::integer as n from events where clan_id = ${clan.id} and type = 'context.written'`;
  assert.equal(audit.n, 2);
});
