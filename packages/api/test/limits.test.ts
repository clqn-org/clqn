import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createApp } from '../src/app.js';
import { limits } from '../src/limits.js';
import { createStore } from '../src/store.js';

test('PostgreSQL: clan, agent and context limits hold under concurrent writes', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const url = process.env.TEST_DATABASE_URL!;
  const sql = postgres(url, { max: 2 });
  const connection = createStore(url);
  const saved = { ...limits };
  const userIds: string[] = [];
  t.after(async () => {
    Object.assign(limits, saved);
    try {
      if (userIds.length) {
        const clans = sql`select id from clans where created_by in ${sql(userIds)}`;
        await sql`delete from context_revisions where clan_id in (${clans})`;
        await sql`delete from context_entries where clan_id in (${clans})`;
        await sql`delete from events where actor_id in ${sql(userIds)}`;
        await sql`delete from credentials where user_id in ${sql(userIds)}`;
        await sql`delete from agents where owner_id in ${sql(userIds)}`;
        await sql`delete from memberships where user_id in ${sql(userIds)}`;
        await sql`delete from clans where created_by in ${sql(userIds)}`;
        await sql`delete from users where id in ${sql(userIds)}`;
      }
    } finally {
      await connection.close();
      await sql.end();
    }
  });
  await migrate(drizzle(sql), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  Object.assign(limits, { clansPerUser: 2, agentsPerMember: 2, contextEntriesPerClan: 2, contextRevisionsKept: 3 });
  const alice = await connection.provisionUser(`${randomUUID()}@example.com`);
  userIds.push(alice.user.id);
  const app = createApp(connection.store, connection.db);
  const post = (path: string, body: object) =>
    app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const statuses = async (requests: (Response | Promise<Response>)[]) =>
    (await Promise.all(requests)).map((r) => r.status).sort();
  // Each check runs concurrently at the edge of its limit: exactly the remaining capacity succeeds.
  const clans = await statuses([1, 2, 3].map((i) => post('/v1/clans', { name: `Clan ${i}` })));
  assert.deepEqual(clans, [201, 201, 409]);
  const limited = await post('/v1/clans', { name: 'One more' });
  assert.deepEqual(await limited.json(), {
    error: { code: 'LIMIT_REACHED', message: 'You can create at most 2 clans' },
  });
  const [clan] = (
    await (await app.request('/v1/clans', { headers: { authorization: `Bearer ${alice.token}` } })).json()
  ).clans;
  const agents = await statuses([1, 2, 3].map((i) => post(`/v1/clans/${clan.id}/agents`, { name: `Agent ${i}` })));
  assert.deepEqual(agents, [201, 201, 409]);
  const [credentials] =
    await sql`select count(*)::integer as n from credentials c join agents a on a.id = c.agent_id where a.clan_id = ${clan.id}`;
  assert.equal(credentials?.n, 2);
  const write = (key: string, text: string, expectedRevision: number) =>
    post(`/v1/clans/${clan.id}/context/${key}`, { text, expectedRevision });
  const entries = await statuses(['a', 'b', 'c'].map((key) => write(key, key, 0)));
  assert.deepEqual(entries, [201, 201, 409]);
  // Updates are not blocked by the entry cap, and only the latest revisions are kept.
  const [created] = await sql`select key from context_entries where clan_id = ${clan.id} order by key limit 1`;
  for (let revision = 1; revision <= 4; revision++)
    assert.equal((await write(created!.key, `v${revision}`, revision)).status, 200);
  const history = await (
    await app.request(`/v1/clans/${clan.id}/context/${created!.key}/history`, {
      headers: { authorization: `Bearer ${alice.token}` },
    })
  ).json();
  assert.deepEqual(
    history.revisions.map((entry: { revision: number }) => entry.revision),
    [3, 4, 5],
  );
});
