import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { cleanupDatabase } from '../src/db/cleanup.js';

test('PostgreSQL: cleanup prunes expired history across clans and preserves current state', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const client = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const userId = randomUUID();
  const clans = [randomUUID(), randomUUID()];
  t.after(async () => {
    try {
      await client`delete from linked_repositories where clan_id in ${client(clans)}`;
      await client`delete from context_revisions where clan_id in ${client(clans)}`;
      await client`delete from context_entries where clan_id in ${client(clans)}`;
      await client`delete from events where clan_id in ${client(clans)}`;
      await client`delete from clans where id in ${client(clans)}`;
      await client`delete from users where id = ${userId}`;
    } finally {
      await client.end();
    }
  });
  await client`insert into users (id, email) values (${userId}, ${`${userId}@example.com`})`;
  for (const clanId of clans) {
    await client`insert into clans (id, name, created_by) values (${clanId}, 'Cleanup test', ${userId})`;
    await client`insert into events (clan_id, actor_id, type, created_at)
      values (${clanId}, ${userId}, 'task.created', now() - interval '91 days'),
        (${clanId}, ${userId}, 'task.created', now() - interval '89 days')`;
    const [link] = await client`insert into linked_repositories (clan_id, slug, created_by)
      values (${clanId}, 'example/project', ${userId}) returning id`;
    await client`insert into github_deliveries (binding_id, delivery_id, received_at)
      values (${link!.id}, ${randomUUID()}, now() - interval '31 days'),
        (${link!.id}, ${randomUUID()}, now() - interval '29 days')`;
    await client`insert into context_entries (clan_id, key, text, revision, updated_at)
      values (${clanId}, 'notes', 'Current', 105, now())`;
    await client`insert into context_revisions (clan_id, key, text, revision, updated_at)
      select ${clanId}, 'notes', 'Revision ' || n, n, now() from generate_series(1, 105) n`;
  }
  const result = await cleanupDatabase(db);
  assert.ok(result.events >= 2);
  assert.ok(result.deliveries >= 2);
  assert.ok(result.revisions >= 10);
  for (const clanId of clans) {
    const [events] = await client`select count(*)::integer as n from events where clan_id = ${clanId}`;
    assert.equal(events!.n, 1);
    const [deliveries] = await client`select count(*)::integer as n from github_deliveries d
      join linked_repositories r on r.id = d.binding_id where r.clan_id = ${clanId}`;
    assert.equal(deliveries!.n, 1);
    const [history] = await client`select count(*)::integer as n, min(revision) as first, max(revision) as last
      from context_revisions where clan_id = ${clanId} and key = 'notes'`;
    assert.deepEqual(history, { n: 100, first: 6, last: 105 });
    const [current] = await client`select text, revision from context_entries where clan_id = ${clanId}`;
    assert.deepEqual(current, { text: 'Current', revision: 105 });
  }
  assert.deepEqual(await cleanupDatabase(db), { events: 0, deliveries: 0, revisions: 0 });
});
