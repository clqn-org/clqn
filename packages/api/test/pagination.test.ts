import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClqnClient } from '@clqn/shared';
import { serve } from '@hono/node-server';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';

test('PostgreSQL: resource lists page by default, preserve client results and enforce clan scope', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 2 });
  const connection = createStore(process.env.TEST_DATABASE_URL!);
  const userIds: string[] = [];
  const clanIds: string[] = [];
  t.after(async () => {
    try {
      if (clanIds.length) {
        await sql`delete from linked_repositories where clan_id in ${sql(clanIds)}`;
        await sql`delete from context_entries where clan_id in ${sql(clanIds)}`;
        await sql`delete from events where clan_id in ${sql(clanIds)}`;
        await sql`delete from credentials where user_id in ${sql(userIds)}`;
        await sql`delete from agents where clan_id in ${sql(clanIds)}`;
        await sql`delete from memberships where clan_id in ${sql(clanIds)}`;
        await sql`delete from clans where id in ${sql(clanIds)}`;
        await sql`delete from users where id in ${sql(userIds)}`;
      }
    } finally {
      await connection.close();
      await sql.end();
    }
  });
  await migrate(drizzle(sql), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const alice = await connection.provisionUser(`${randomUUID()}@example.com`);
  const bob = await connection.provisionUser(`${randomUUID()}@example.com`);
  userIds.push(alice.user.id, bob.user.id);
  const clan = await connection.store.createClan(alice.user.id, 'Page test');
  const other = await connection.store.createClan(bob.user.id, 'Other page test');
  clanIds.push(clan.id, other.id);
  const worker = await connection.store.registerAgent(alice.user, clan.id, 'Worker');
  for (let n = 0; n < 100; n++) {
    const id = randomUUID();
    const extraClan = randomUUID();
    userIds.push(id);
    clanIds.push(extraClan);
    await sql`insert into users (id, email) values (${id}, ${`${id}@example.com`})`;
    await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${id})`;
    await sql`insert into clans (id, name, created_by) values (${extraClan}, 'Another', ${alice.user.id})`;
    await sql`insert into memberships (clan_id, user_id, role) values (${extraClan}, ${alice.user.id}, 'leader')`;
    await sql`insert into agents (clan_id, owner_id, name) values (${clan.id}, ${alice.user.id}, ${`Worker ${n}`})`;
  }
  // The agent's clan falls outside the first human page; scope must be applied before pagination.
  await sql`update clans set created_at = now() + interval '1 day' where id = ${clan.id}`;
  await sql`insert into linked_repositories (clan_id, slug, created_by)
    select ${clan.id}, 'example/repo' || n, ${alice.user.id} from generate_series(1, 101) n`;
  await sql`insert into context_entries (clan_id, key, text, revision, updated_at)
    select ${clan.id}, 'note' || n, 'Current', 1, now() from generate_series(1, 101) n`;
  const app = createApp(connection.store, connection.db);
  const headers = { authorization: `Bearer ${alice.token}` };
  const base = `/v1/clans/${clan.id}`;
  for (const [path, key, id] of [
    ['/v1/clans', 'clans', 'id'],
    [`${base}/members`, 'members', 'userId'],
    [`${base}/agents`, 'agents', 'id'],
    [`${base}/repositories`, 'repositories', 'id'],
    [`${base}/context`, 'entries', 'key'],
  ] as const) {
    const first = await (await app.request(path, { headers })).json();
    assert.equal(first[key].length, 100, path);
    assert.ok(first.nextCursor, path);
    const last = await (await app.request(`${path}?after=${encodeURIComponent(first.nextCursor)}`, { headers })).json();
    assert.equal(last[key].length, 1, path);
    assert.equal(last.nextCursor, undefined, path);
    const all = [...first[key], ...last[key]] as Record<string, string>[];
    assert.equal(new Set(all.map((row) => row[id])).size, 101, path);
    assert.equal((await app.request(`${path}?limit=0`, { headers })).status, 400);
  }
  const scoped = await app.request('/v1/clans', { headers: { authorization: `Bearer ${worker.token}` } });
  assert.deepEqual(
    (await scoped.json()).clans.map((row: { id: string }) => row.id),
    [clan.id],
  );
  for (const path of ['/v1/clans', `${base}/members`, `${base}/agents`, `${base}/repositories`]) {
    const response = await app.request(`${path}?after=${other.id}`, { headers });
    const body = await response.json();
    assert.equal(Object.values(body).flat().length, 0, path);
  }
  const outside = await app.request(`/v1/clans/${other.id}/agents?limit=2`, { headers });
  assert.equal(outside.status, 404);

  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const client = new ClqnClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, alice.token);
  assert.equal((await client.listClans()).clans.length, 101);
  assert.equal((await client.members(clan.id)).members.length, 101);
  assert.equal((await client.listAgents(clan.id)).agents.length, 101);
  assert.equal((await client.repositories(clan.id)).repositories.length, 101);
  assert.equal((await client.listContext(clan.id)).entries.length, 101);
});
