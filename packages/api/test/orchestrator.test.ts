import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentSchema, registerAgentSchema } from '@clqn/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createApp } from '../src/app.js';
import { createStore } from '../src/db/store.js';

test('agent contracts preserve worker defaults and restrict orchestrator role values', () => {
  assert.deepEqual(registerAgentSchema.parse({ name: 'Codex' }), { name: 'Codex', role: 'worker' });
  assert.deepEqual(registerAgentSchema.parse({ name: 'Coordinator', role: 'orchestrator' }), {
    name: 'Coordinator',
    role: 'orchestrator',
  });
  assert.equal(registerAgentSchema.safeParse({ name: 'Escalated', role: 'leader' }).success, false);
  assert.equal(
    agentSchema.parse({
      id: randomUUID(),
      clanId: randomUUID(),
      ownerId: randomUUID(),
      name: 'Legacy',
      createdAt: new Date().toISOString(),
    }).role,
    'worker',
  );
});

test('PostgreSQL: only a personal leader registers one orchestrator per clan under concurrent requests', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 5 });
  const connection = createStore(process.env.TEST_DATABASE_URL!);
  const userIds: string[] = [];
  const clanIds: string[] = [];
  t.after(async () => {
    try {
      if (clanIds.length) {
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
  const clan = await connection.store.createClan(alice.user.id, 'Orchestrator');
  const other = await connection.store.createClan(alice.user.id, 'Another orchestrator');
  clanIds.push(clan.id, other.id);
  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${bob.user.id})`;
  const app = createApp(connection.store, connection.db);
  const post = (token: string, path: string, body: object) =>
    app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const path = `/v1/clans/${clan.id}/agents`;
  assert.equal((await post(bob.token, path, { name: 'Not leader', role: 'orchestrator' })).status, 403);
  const worker = await (await post(bob.token, path, { name: 'Worker', alias: 'writer' })).json();
  assert.equal(worker.agent.role, 'worker');
  assert.equal(worker.agent.alias, 'writer');
  const responses = await Promise.all([
    post(alice.token, path, { name: 'First', role: 'orchestrator' }),
    post(alice.token, path, { name: 'Second', role: 'orchestrator' }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const orchestrator = await responses.find((r) => r.status === 201)?.json();
  assert.equal(orchestrator.agent.role, 'orchestrator');
  assert.equal(orchestrator.agent.ownerId, alice.user.id);
  assert.equal((await responses.find((r) => r.status === 409)?.json())?.error.code, 'ORCHESTRATOR_EXISTS');
  const [counts] =
    await sql`select count(*)::integer as n from agents where clan_id = ${clan.id} and role = 'orchestrator'`;
  assert.equal(counts?.n, 1);
  const [credentials] =
    await sql`select count(*)::integer as n from credentials c join agents a on a.id = c.agent_id where a.clan_id = ${clan.id}`;
  assert.equal(credentials?.n, 2);
  const [events] =
    await sql`select count(*)::integer as n from events where clan_id = ${clan.id} and type = 'agent.registered'`;
  assert.equal(events?.n, 2);
  assert.equal(
    (await post(alice.token, `/v1/clans/${other.id}/agents`, { name: 'Other', role: 'orchestrator', alias: 'writer' }))
      .status,
    201,
  );
  const rename = (token: string, ref: string, alias: string) => post(token, `${path}/${ref}/alias`, { alias });
  assert.equal((await rename(alice.token, 'writer', 'editor')).status, 403);
  assert.equal((await rename(worker.token, 'writer', 'editor')).status, 403);
  const racing = await Promise.all([
    rename(bob.token, 'writer', 'editor'),
    rename(alice.token, orchestrator.agent.id, 'editor'),
  ]);
  assert.deepEqual(racing.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await racing.find((response) => response.status === 409)?.json())?.error.code, 'ALIAS_CONFLICT');
  const winner = await racing.find((response) => response.status === 200)?.json();
  const owner = winner.id === worker.agent.id ? bob.token : alice.token;
  assert.equal(winner.alias, 'editor');
  assert.equal((await rename(owner, winner.id, 'editor')).status, 200);
  assert.equal((await post(bob.token, path, { name: 'Another worker', alias: 'editor' })).status, 409);
  const changes =
    await sql`select actor_id, resource_id from events where clan_id = ${clan.id} and type = 'agent.alias_changed'`;
  assert.deepEqual([...changes], [{ actor_id: winner.ownerId, resource_id: winner.id }]);
  // The designated agent does not inherit the leader's administrative credential.
  for (const [adminPath, body] of <[string, object][]>[
    [path, { name: 'Child', role: 'worker' }],
    [`/v1/clans/${clan.id}/invitations`, { email: bob.user.email }],
    [`/v1/clans/${clan.id}/policy`, { expectedRevision: 0, control: 'automatic' }],
  ])
    assert.equal((await post(orchestrator.token, adminPath, body)).status, 403);
  const list = await connection.store.listAgents(alice.user, clan.id);
  assert.equal(list.find((a) => a.id === orchestrator.agent.id)?.role, 'orchestrator');
  const registration = await app.request('/v1/agent', { headers: { authorization: `Bearer ${orchestrator.token}` } });
  assert.equal((await registration.json()).role, 'orchestrator');
  await assert.rejects(
    sql`insert into agents (clan_id, owner_id, name, role) values (${other.id}, ${alice.user.id}, 'Bad role', 'leader')`,
    { code: '23514' },
  );
});
