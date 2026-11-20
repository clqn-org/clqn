import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { Hono } from 'hono';
import { createStore } from '../dist/store.js';
import { createTaskRoutes } from '../dist/tasks.js';
import { ApiError, taskSchema } from '@clqn/shared';

const post = (app, path, actor, body = {}) => app.request(path, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-test-actor': actor }, body: JSON.stringify(body),
});

test('PostgreSQL: task claims serialize and only the owning human or agent completes work', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const sql = postgres(process.env.TEST_DATABASE_URL, { max: 5 });
  const db = drizzle(sql);
  const connection = createStore(process.env.TEST_DATABASE_URL);
  const userIds = [];
  const clanIds = [];
  t.after(async () => {
    try {
      if (clanIds.length) {
        await sql`delete from events where clan_id in ${sql(clanIds)}`;
        await sql`delete from tasks where clan_id in ${sql(clanIds)}`;
        await sql`delete from credentials where user_id in ${sql(userIds)}`;
        await sql`delete from agents where clan_id in ${sql(clanIds)}`;
        await sql`delete from memberships where clan_id in ${sql(clanIds)}`;
        await sql`delete from clans where id in ${sql(clanIds)}`;
      }
      if (userIds.length) await sql`delete from users where id in ${sql(userIds)}`;
    } finally { await connection.close(); await sql.end(); }
  });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const alice = await connection.provisionUser(`${randomUUID()}@example.com`);
  const bob = await connection.provisionUser(`${randomUUID()}@example.com`);
  userIds.push(alice.user.id, bob.user.id);
  const clan = await connection.store.createClan(alice.user.id, 'Task test');
  const other = await connection.store.createClan(bob.user.id, 'Other task test');
  clanIds.push(clan.id, other.id);
  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${bob.user.id})`;
  const [agentOne, agentTwo] = await sql`insert into agents (clan_id, owner_id, name) values
    (${clan.id}, ${bob.user.id}, 'one'), (${clan.id}, ${bob.user.id}, 'two') returning id`;
  const actors = {
    alice: alice.user, bob: bob.user,
    one: { ...bob.user, agentId: agentOne.id, clanId: clan.id },
    two: { ...bob.user, agentId: agentTwo.id, clanId: clan.id },
  };
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('user', actors[c.req.header('x-test-actor') ?? 'alice']); await next(); });
  app.route('/v1/clans/:clanId/tasks', createTaskRoutes(db));
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: { code: error.code } }, error.status);
    throw error;
  });
  const path = `/v1/clans/${clan.id}/tasks`;
  const create = await post(app, path, 'alice', { description: ' Shared work ' });
  assert.equal(create.status, 201);
  const task = taskSchema.parse(await create.json());
  assert.match(task.alias, /^task-[1-9][0-9]*$/);
  assert.equal(task.description, 'Shared work');
  assert.equal(task.status, 'open');
  assert.equal(task.ownerId, null);
  const claims = await Promise.all([
    post(app, `${path}/${task.alias}/claim`, 'alice'),
    post(app, `${path}/${task.id}/claim`, 'bob'),
  ]);
  assert.deepEqual(claims.map((r) => r.status).sort(), [200, 409]);
  const winner = claims[0].status === 200 ? 'alice' : 'bob';
  const loser = winner === 'alice' ? 'bob' : 'alice';
  assert.equal((await post(app, `${path}/${task.id}/complete`, loser)).status, 409);
  const completed = await post(app, `${path}/${task.id}/complete`, winner);
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).status, 'completed');
  assert.equal((await post(app, `${path}/${task.id}/release`, winner)).status, 409);
  const agentTask = await (await post(app, path, 'one', { description: 'Agent work' })).json();
  assert.equal((await post(app, `${path}/${agentTask.id}/claim`, 'one')).status, 200);
  for (const actor of ['bob', 'two']) {
    assert.equal((await post(app, `${path}/${agentTask.id}/complete`, actor)).status, 409);
    assert.equal((await post(app, `${path}/${agentTask.id}/release`, actor)).status, 409);
  }
  assert.equal((await post(app, `${path}/${agentTask.id}/release`, 'alice')).status, 200);
  assert.equal((await post(app, `${path}/${agentTask.id}/claim`, 'two')).status, 200);
  assert.equal((await post(app, `${path}/${agentTask.alias}/complete`, 'two')).status, 200);
  const [audit] = await sql`select count(*)::integer as n from events where clan_id = ${clan.id} and type = 'task.claimed'`;
  assert.equal(audit.n, 3);
  const [agentAudit] = await sql`select agent_id, resource_id from events where clan_id = ${clan.id} and type = 'task.completed' and agent_id is not null`;
  assert.equal(agentAudit.agent_id, agentTwo.id);
  assert.equal(agentAudit.resource_id, agentTask.id);
  assert.equal((await post(app, `/v1/clans/${other.id}/tasks/${task.id}/claim`, 'bob')).status, 404);
  assert.equal((await post(app, `/v1/clans/${other.id}/tasks/${task.alias}/claim`, 'bob')).status, 404);
  assert.equal((await post(app, `/v1/clans/${other.id}/tasks`, 'one', { description: 'Escape' })).status, 404);
  assert.equal((await post(app, `${path}/not-a-uuid/claim`, 'alice')).status, 404);
  assert.equal((await post(app, path, 'alice', { description: ' ', ownerId: bob.user.id })).status, 400);
  assert.equal((await post(app, `${path}/${agentTask.id}/claim`, 'one', { ownerId: bob.user.id })).status, 400);
  const concurrent = await Promise.all([1, 2].map(() => post(app, path, 'alice', { description: 'Parallel' })));
  assert.deepEqual(concurrent.map((response) => response.status), [201, 201]);
  const created = await Promise.all(concurrent.map((response) => response.json()));
  const aliases = [task, agentTask, ...created].map((entry) => entry.alias);
  assert.equal(new Set(aliases).size, 4);
  const listing = await app.request(path, { headers: { 'x-test-actor': 'bob' } });
  assert.deepEqual((await listing.json()).tasks.map((entry) => entry.alias).sort(), aliases.sort());
});
