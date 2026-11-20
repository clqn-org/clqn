import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTaskSchema, repositoryReportSchema, taskSchema } from '@clqn/shared';
import { createApp } from '../dist/app.js';
import { createStore } from '../dist/store.js';

const repository = { slug: 'example/project', baseSha: 'a'.repeat(40), branch: 'clqn/task-one' };

test('repository task contracts reject unsafe refs and incomplete repository reports', () => {
  for (const branch of ['--help', 'main~1', 'a..b', 'a//b', 'a/.hidden', 'a.lock', 'a/', 'main\n', 'a@{1}', 'main', 'HEAD', 'refs/heads/task']) {
    assert.equal(createTaskSchema.safeParse({ description: 'Work', repository: { ...repository, branch } }).success, false, branch);
  }
  for (const slug of ['https://github.com/example/project', '../project', 'example/project/extra', '-owner/project', 'owner/.git', 'owner/project.git']) {
    assert.equal(createTaskSchema.safeParse({ description: 'Work', repository: { ...repository, slug } }).success, false, slug);
  }
  assert.equal(createTaskSchema.safeParse({ description: 'Work', repository: { ...repository, baseSha: 'main' } }).success, false);
  assert.equal(repositoryReportSchema.safeParse({ expectedHeadSha: null, headSha: 'b'.repeat(40), prNumber: 1 }).success, false);
  const parsed = createTaskSchema.parse({ description: 'Work', repository: { ...repository, slug: 'Example/Project' } });
  assert.equal(parsed.repository.slug, 'example/project');
  assert.equal(parsed.repository.baseBranch, 'main');
});

test('PostgreSQL: orchestrator delegates isolated repository work and integration gates task completion', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const sql = postgres(process.env.TEST_DATABASE_URL, { max: 5 });
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
  await migrate(drizzle(sql), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const alice = await connection.provisionUser(`${randomUUID()}@example.com`);
  const bob = await connection.provisionUser(`${randomUUID()}@example.com`);
  userIds.push(alice.user.id, bob.user.id);
  const clan = await connection.store.createClan(alice.user.id, 'Repository work');
  const other = await connection.store.createClan(bob.user.id, 'Other repository work');
  clanIds.push(clan.id, other.id);
  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${bob.user.id})`;
  const orchestrator = await connection.store.registerAgent(alice.user, clan.id, 'Coordinator', 'orchestrator');
  const regular = await connection.store.registerAgent(alice.user, clan.id, 'Leader worker');
  const worker = await connection.store.registerAgent(bob.user, clan.id, 'Worker', 'worker', 'build');
  const secondWorker = await connection.store.registerAgent(bob.user, clan.id, 'Second worker', 'worker', 'review');
  const outsideWorker = await connection.store.registerAgent(bob.user, other.id, 'Outside worker', 'worker', 'outside');
  const app = createApp(connection.store, connection.db);
  const request = (token, suffix = '', body, clanId = clan.id) => app.request(`/v1/clans/${clanId}/tasks${suffix}`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const creation = await request(orchestrator.token, '', { description: 'Build endpoint', alias: 'build', repository });
  assert.equal(creation.status, 201);
  const task = taskSchema.parse(await creation.json());
  assert.deepEqual(task.repository, { ...repository, baseBranch: 'main', headSha: null,
    prNumber: null, prUrl: null, mergeCommitSha: null, state: 'pending' });
  assert.equal(task.assignedAgentId, null);
  assert.deepEqual(taskSchema.parse(await (await request(worker.token, `/${task.id}`)).json()), task);
  assert.equal((await request(alice.token, `/${task.id}`, undefined, other.id)).status, 404);
  assert.equal((await request(alice.token, '', { description: 'Duplicate branch', repository: { ...repository, slug: 'EXAMPLE/PROJECT' } })).status, 409);
  const aliasChange = await request(orchestrator.token, '/build/alias', { alias: 'ship' });
  assert.equal(aliasChange.status, 200);
  assert.equal((await aliasChange.json()).id, task.id);
  const assign = (token, agentId) => request(token, '/ship/assign', { agentId });
  assert.equal((await assign(bob.token, worker.agent.id)).status, 403);
  assert.equal((await assign(regular.token, worker.agent.id)).status, 403);
  assert.equal((await assign(orchestrator.token, outsideWorker.agent.id)).status, 404);
  assert.equal((await assign(orchestrator.token, outsideWorker.agent.alias)).status, 404);
  const assignments = await Promise.all([assign(orchestrator.token, worker.agent.alias), assign(alice.token, secondWorker.agent.alias)]);
  assert.deepEqual(assignments.map((r) => r.status).sort(), [200, 409]);
  const assigned = await assignments.find((r) => r.status === 200).json();
  const owner = assigned.assignedAgentId === worker.agent.id ? worker : secondWorker;
  const loser = owner === worker ? secondWorker : worker;
  assert.equal((await assign(alice.token, owner.agent.id)).status, 200);
  assert.equal((await request(bob.token, `/${task.id}/claim`, {})).status, 409);
  assert.equal((await request(loser.token, `/${task.id}/claim`, {})).status, 409);
  assert.equal((await request(owner.token, `/${task.id}/claim`, {})).status, 200);
  assert.equal((await request(owner.token, `/${task.id}/complete`, {})).status, 409);
  const report = (token, body) => request(token, '/ship/repository', body);
  assert.equal((await report(loser.token, { expectedHeadSha: null, headSha: 'b'.repeat(40) })).status, 409);
  const heads = await Promise.all(['b', 'c'].map((letter) => report(owner.token, { expectedHeadSha: null, headSha: letter.repeat(40) })));
  assert.deepEqual(heads.map((r) => r.status).sort(), [200, 409]);
  const pushed = await heads.find((r) => r.status === 200).json();
  assert.equal(pushed.repository.state, 'pushed');
  assert.equal((await report(owner.token, { expectedHeadSha: pushed.repository.headSha, headSha: pushed.repository.headSha,
    prNumber: 1, prUrl: 'https://github.com/other/repository/pull/1' })).status, 400);
  assert.equal((await report(owner.token, { expectedHeadSha: pushed.repository.headSha, headSha: pushed.repository.headSha,
    baseSha: 'd'.repeat(40) })).status, 400);
  const pr = { expectedHeadSha: pushed.repository.headSha, headSha: pushed.repository.headSha,
    prNumber: 1, prUrl: 'https://github.com/Example/Project/pull/1' };
  const reported = await report(owner.token, pr);
  assert.equal(reported.status, 200);
  assert.equal((await reported.json()).repository.prUrl, 'https://github.com/example/project/pull/1');
  const integrate = (token, headSha = pushed.repository.headSha) => request(token, '/ship/integration', {
    headSha, mergeCommitSha: 'd'.repeat(40),
  });
  assert.equal((await integrate(owner.token)).status, 403);
  assert.equal((await integrate(regular.token)).status, 403);
  assert.equal((await integrate(alice.token, 'e'.repeat(40))).status, 409);
  const integration = await integrate(orchestrator.token);
  assert.equal(integration.status, 200);
  assert.equal((await integration.json()).repository.state, 'merged');
  assert.equal((await integrate(orchestrator.token)).status, 200);
  assert.equal((await report(owner.token, pr)).status, 409);
  assert.equal((await request(bob.token, `/${task.id}/complete`, {})).status, 409);
  assert.equal((await request(owner.token, '/ship/complete', {})).status, 200);
  const resetTask = await (await request(alice.token, '', { description: 'Release assignment' })).json();
  assert.equal((await request(alice.token, `/${resetTask.id}/assign`, { agentId: worker.agent.id })).status, 200);
  assert.equal((await request(worker.token, `/${resetTask.id}/claim`, {})).status, 200);
  const released = await request(alice.token, `/${resetTask.id}/release`, {});
  assert.equal(released.status, 200);
  assert.equal((await released.json()).assignedAgentId, null);
  assert.equal((await request(orchestrator.token, `/${resetTask.id}/assign`, { agentId: secondWorker.agent.id })).status, 200);
  assert.equal((await request(regular.token, `/${resetTask.id}/unassign`, { agentId: secondWorker.agent.id })).status, 403);
  assert.equal((await request(alice.token, `/${resetTask.id}/unassign`, { agentId: worker.agent.id })).status, 409);
  assert.equal((await request(orchestrator.token, `/${resetTask.id}/unassign`, { agentId: secondWorker.agent.alias })).status, 200);
  assert.equal((await request(orchestrator.token, `/${resetTask.id}/unassign`, { agentId: secondWorker.agent.id })).status, 409);
  const [counts] = await sql`select
    count(*) filter (where type = 'task.assigned')::integer as assignments,
    count(*) filter (where type = 'task.repository_updated')::integer as reports,
    count(*) filter (where type = 'task.integrated')::integer as integrations,
    count(*) filter (where type = 'task.unassigned')::integer as unassignments
    from events where clan_id = ${clan.id}`;
  assert.deepEqual(counts, { assignments: 3, reports: 2, integrations: 1, unassignments: 1 });
});
