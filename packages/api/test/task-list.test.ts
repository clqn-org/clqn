import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Actor, ApiError, tasksSchema } from '@clqn/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { Hono } from 'hono';
import postgres from 'postgres';
import { createStore } from '../src/db/store.js';
import { createTaskRoutes } from '../src/routes/tasks.js';

test('PostgreSQL: task lists filter by status and caller and page with a stable cursor', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 5 });
  const db = drizzle(sql);
  const connection = createStore(process.env.TEST_DATABASE_URL!);
  const userIds: string[] = [];
  const clanIds: string[] = [];
  t.after(async () => {
    try {
      if (clanIds.length) {
        await sql`delete from events where clan_id in ${sql(clanIds)}`;
        await sql`delete from tasks where clan_id in ${sql(clanIds)}`;
        await sql`delete from agents where clan_id in ${sql(clanIds)}`;
        await sql`delete from memberships where clan_id in ${sql(clanIds)}`;
        await sql`delete from clans where id in ${sql(clanIds)}`;
      }
      if (userIds.length) {
        await sql`delete from credentials where user_id in ${sql(userIds)}`;
        await sql`delete from users where id in ${sql(userIds)}`;
      }
    } finally {
      await connection.close();
      await sql.end();
    }
  });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const alice = await connection.provisionUser(`${randomUUID()}@example.com`);
  userIds.push(alice.user.id);
  const clan = await connection.store.createClan(alice.user.id, 'Task list test');
  const other = await connection.store.createClan(alice.user.id, 'Other task list test');
  clanIds.push(clan.id, other.id);
  const [agent] =
    await sql`insert into agents (clan_id, owner_id, name) values (${clan.id}, ${alice.user.id}, 'one') returning id`;
  assert.ok(agent);
  const actors: Record<string, Actor> = {
    alice: alice.user,
    agent: { ...alice.user, agentId: agent.id, clanId: clan.id },
  };
  const app = new Hono<{ Variables: { user: Actor } }>();
  app.use('*', async (c, next) => {
    c.set('user', actors[c.req.header('x-test-actor') ?? 'alice']!);
    await next();
  });
  app.route('/v1/clans/:clanId/tasks', createTaskRoutes(db));
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: { code: error.code } }, error.status as 400 | 404);
    throw error;
  });
  const path = `/v1/clans/${clan.id}/tasks`;
  const post = (url: string, actor = 'alice', body: object = {}) =>
    app.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-actor': actor },
      body: JSON.stringify(body),
    });
  const list = async (query = '', actor = 'alice') => {
    const response = await app.request(`${path}${query}`, { headers: { 'x-test-actor': actor } });
    assert.equal(response.status, 200);
    return tasksSchema.parse(await response.json());
  };
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await (await post(path, 'alice', { description: `Task ${i}` })).json()).id);
  await post(`/v1/clans/${other.id}/tasks`, 'alice', { description: 'Elsewhere' });
  // Task 0 is claimed by Alice personally; task 1 is assigned to the agent; task 2 is claimed by the agent.
  await post(`${path}/${ids[0]}/claim`);
  await post(`${path}/${ids[1]}/assign`, 'alice', { agentId: agent.id });
  await post(`${path}/${ids[2]}/claim`, 'agent');
  const all = await list();
  assert.deepEqual(
    all.tasks.map((task) => task.id),
    ids,
  );
  assert.equal(all.nextCursor, undefined);
  assert.deepEqual(
    (await list('?status=open')).tasks.map((task) => task.id),
    [ids[1], ids[3], ids[4]],
  );
  assert.deepEqual(
    (await list('?mine=true')).tasks.map((task) => task.id),
    [ids[0]],
  );
  assert.deepEqual(
    (await list('?mine=true', 'agent')).tasks.map((task) => task.id),
    [ids[1], ids[2]],
  );
  assert.deepEqual(
    (await list('?mine=true&status=open', 'agent')).tasks.map((task) => task.id),
    [ids[1]],
  );
  // Pages are contiguous and the last page has no cursor.
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(`?limit=2${cursor ? `&after=${cursor}` : ''}`);
    assert.ok(page.tasks.length <= 2);
    seen.push(...page.tasks.map((task) => task.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ids);
  for (const query of ['?status=done', '?mine=yes', '?limit=0', '?limit=201', '?after=task-1', '?other=1']) {
    const response = await app.request(`${path}${query}`);
    assert.equal(response.status, 400, query);
  }
});
