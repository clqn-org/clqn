import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { eventsSchema, statsSchema, statusSchema } from '@clqn/shared';
import { sql as query } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { appendEvent } from '../dist/access.js';
import { createApp } from '../dist/app.js';
import { tasks } from '../dist/db/tasks.js';
import { createStore } from '../dist/store.js';

test('PostgreSQL: clan activity, bounded cursor pagination, atomic audit, and commit-ordered polling', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
  timeout: 15_000,
}, async (t) => {
  const sql = postgres(process.env.TEST_DATABASE_URL, { max: 2 });
  const connection = createStore(process.env.TEST_DATABASE_URL);
  const userIds = [];
  const clanIds = [];
  t.after(async () => {
    try {
      if (clanIds.length) {
        await sql`delete from tasks where clan_id in ${sql(clanIds)}`;
        await sql`delete from events where clan_id in ${sql(clanIds)}`;
        await sql`delete from credentials where user_id in ${sql(userIds)}`;
        await sql`delete from agents where clan_id in ${sql(clanIds)}`;
        await sql`delete from memberships where clan_id in ${sql(clanIds)}`;
        await sql`delete from clans where id in ${sql(clanIds)}`;
      }
      if (userIds.length) await sql`delete from users where id in ${sql(userIds)}`;
    } finally {
      await connection.close();
      await sql.end();
    }
  });
  await migrate(drizzle(sql), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const alice = await connection.provisionUser(`${randomUUID()}@example.com`);
  const bob = await connection.provisionUser(`${randomUUID()}@example.com`);
  userIds.push(alice.user.id, bob.user.id);
  const clan = await connection.store.createClan(alice.user.id, 'Activity');
  const other = await connection.store.createClan(bob.user.id, 'Other');
  clanIds.push(clan.id, other.id);
  const app = createApp(connection.store, connection.db);
  const auth = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const get = (suffix, token = alice.token) => app.request(`/v1/clans/${clan.id}/${suffix}`, { headers: auth(token) });
  const post = (suffix, body, token = alice.token) =>
    app.request(`/v1/clans/${clan.id}/${suffix}`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify(body),
    });
  const registration = await connection.store.registerAgent(alice.user, clan.id, 'Activity agent');
  const open = await (await post('tasks', { description: 'Open task' }, registration.token)).json();
  const claimed = await (await post('tasks', { description: 'Claimed task' })).json();
  const completed = await (await post('tasks', { description: 'Completed task' })).json();
  assert.equal((await post(`tasks/${claimed.id}/claim`, {})).status, 200);
  assert.equal((await post(`tasks/${completed.id}/claim`, {})).status, 200);
  assert.equal((await post(`tasks/${completed.id}/complete`, {})).status, 200);
  const stats = statsSchema.parse(await (await get('stats')).json());
  assert.deepEqual(stats, { members: 1, agents: 1, tasks: { open: 1, claimed: 1, completed: 1 } });
  const status = statusSchema.parse(await (await get('status')).json());
  assert.deepEqual(status.clan, { id: clan.id, name: clan.name });
  assert.deepEqual(status.stats, stats);
  assert.ok(status.recentActivity.length <= 10);
  assert.ok(status.recentActivity.every((event) => event.clanId === clan.id));
  for (const suffix of ['stats', 'status', 'events']) assert.equal((await get(suffix, bob.token)).status, 404);
  const otherStats = await app.request(`/v1/clans/${other.id}/stats`, { headers: auth(bob.token) });
  assert.deepEqual((await otherStats.json()).tasks, { open: 0, claimed: 0, completed: 0 });

  const all = eventsSchema.parse(await (await get('events')).json());
  const agentEvent = all.events.find((event) => event.resourceId === open.id);
  assert.equal(agentEvent.actorId, alice.user.id);
  assert.equal(agentEvent.agentId, registration.agent.id);
  let cursor = 0;
  const seen = [];
  for (;;) {
    const page = eventsSchema.parse(await (await get(`events?cursor=${cursor}&limit=2`)).json());
    assert.ok(page.events.length <= 2);
    seen.push(...page.events.map((event) => event.sequence));
    if (!page.events.length) {
      assert.equal(page.nextCursor, cursor);
      break;
    }
    assert.ok(page.nextCursor > cursor);
    cursor = page.nextCursor;
  }
  assert.deepEqual(
    seen,
    all.events.map((event) => event.sequence),
  );
  for (const suffix of ['limit=0', 'limit=101', 'limit=1.5', 'cursor=-1', 'cursor=NaN', 'cursor=9007199254740992']) {
    assert.equal((await get(`events?${suffix}`)).status, 400);
  }
  // A failed state mutation and its audit record disappear together.
  const rollbackId = randomUUID();
  await assert.rejects(
    connection.db.transaction(async (tx) => {
      await tx.insert(tasks).values({ id: rollbackId, clanId: clan.id, description: 'Roll back' });
      await appendEvent(tx, { clanId: clan.id, actorId: alice.user.id, resourceId: rollbackId, type: 'task.created' });
      throw new Error('Deliberate rollback');
    }),
    /Deliberate rollback/,
  );
  const [rolledBack] = await sql`select count(*)::integer as n from tasks where id = ${rollbackId}`;
  assert.equal(rolledBack.n, 0);
  assert.deepEqual((await (await get(`events?cursor=${cursor}`)).json()).events, []);

  // Hold an inserted event uncommitted. A later writer must not allocate a visible cursor past it.
  let releaseFirst;
  const holdFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let announceFirst;
  const firstReady = new Promise((resolve) => {
    announceFirst = resolve;
  });
  const first = connection.db.transaction(async (tx) => {
    await appendEvent(tx, { clanId: clan.id, actorId: alice.user.id, type: 'test.first' });
    announceFirst();
    await holdFirst;
  });
  let second;
  try {
    await Promise.race([firstReady, first]);
    let announcePid;
    const secondPid = new Promise((resolve) => {
      announcePid = resolve;
    });
    second = connection.db.transaction(async (tx) => {
      const [row] = await tx.execute(query`select pg_backend_pid() as pid`);
      announcePid(row.pid);
      await appendEvent(tx, { clanId: clan.id, actorId: alice.user.id, type: 'test.second' });
    });
    const pid = await secondPid;
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const [row] =
        await sql`select exists(select 1 from pg_locks where pid = ${pid} and locktype = 'advisory' and not granted) as waiting`;
      waiting = row.waiting;
      if (!waiting) await delay(20);
    }
    assert.equal(waiting, true, 'second writer waits for the first transaction');
    assert.deepEqual((await (await get(`events?cursor=${cursor}`)).json()).events, []);
  } finally {
    releaseFirst();
    await Promise.all([first, ...(second ? [second] : [])]);
  }
  const resumed = eventsSchema.parse(await (await get(`events?cursor=${cursor}`)).json());
  assert.deepEqual(
    resumed.events.map((event) => event.type),
    ['test.first', 'test.second'],
  );
  assert.ok(resumed.events[0].sequence < resumed.events[1].sequence);
});
