import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { database, skip } from './postgres.js';

const master = '0123456789abcdef'.repeat(4);

test('PostgreSQL: only the leader deletes a clan, which removes everything scoped to it', { skip }, async (t) => {
  const { sql, connection, user } = await database(t);
  const alice = await user();
  const bob = await user();
  const carol = await user();
  const app = createApp(connection.store, connection.db, { githubWebhookSecret: master });
  const post = (token: string, path: string, body: object = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const clan = await (await post(alice.token, '/v1/clans', { name: 'Doomed' })).json();
  const kept = await (await post(alice.token, '/v1/clans', { name: 'Kept' })).json();
  const invitation = await (
    await post(alice.token, `/v1/clans/${clan.id}/invitations`, { email: bob.user.email })
  ).json();
  assert.equal((await post(bob.token, '/v1/invitations/join', { code: invitation.code })).status, 200);
  // A pending invitation, agents with tokens, a task, context, a chat with a message, and a repository link.
  assert.equal((await post(alice.token, `/v1/clans/${clan.id}/invitations`, { email: carol.user.email })).status, 201);
  const worker = await connection.store.registerAgent(bob.user, clan.id, 'Worker');
  const orchestrator = await connection.store.registerAgent(alice.user, clan.id, 'Coordinator', 'orchestrator');
  const keptAgent = await connection.store.registerAgent(alice.user, kept.id, 'Elsewhere');
  const task = await (await post(alice.token, `/v1/clans/${clan.id}/tasks`, { description: 'Work' })).json();
  assert.equal(
    (await post(alice.token, `/v1/clans/${clan.id}/context/notes`, { text: 'hi', expectedRevision: 0 })).status,
    201,
  );
  const link = await (await post(alice.token, `/v1/clans/${clan.id}/repositories`, { slug: 'test/doomed' })).json();
  await sql`insert into chats (clan_id, host_id, lease_agent_id, lease_id) values (${clan.id}, ${alice.user.id}, ${orchestrator.agent.id}, ${randomUUID()})`;
  await sql`insert into chat_messages (id, clan_id, author_id, author, role, text, status, worker_id, task_id)
    values (${randomUUID()}, ${clan.id}, ${alice.user.id}, 'alice', 'user', 'hello', 'sent', ${worker.agent.id}, ${task.id})`;

  // Members, agents, and outsiders cannot delete it.
  assert.equal((await post(bob.token, `/v1/clans/${clan.id}/delete`)).status, 403);
  assert.equal((await post(orchestrator.token, `/v1/clans/${clan.id}/delete`)).status, 403);
  assert.equal((await post(carol.token, `/v1/clans/${clan.id}/delete`)).status, 404);
  assert.equal((await post(alice.token, `/v1/clans/${clan.id}/delete`, { force: true })).status, 400);

  const deleted = await post(alice.token, `/v1/clans/${clan.id}/delete`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), {
    deleted: true,
    repositories: [{ id: link.repository.id, slug: 'test/doomed' }],
  });
  assert.equal((await post(alice.token, `/v1/clans/${clan.id}/delete`)).status, 404);

  for (const table of [
    'clans',
    'memberships',
    'invitations',
    'agents',
    'events',
    'tasks',
    'context_entries',
    'context_revisions',
    'linked_repositories',
    'chats',
    'chat_members',
    'chat_messages',
  ]) {
    const column = table === 'clans' ? 'id' : 'clan_id';
    const [row] = await sql`select count(*)::integer as count from ${sql(table)} where ${sql(column)} = ${clan.id}`;
    assert.equal(row!.count, 0, `${table} still has rows for the deleted clan`);
  }
  // Agent tokens stop working, invitations are gone, and other clans are untouched.
  const me = (token: string) => app.request('/v1/me', { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await me(worker.token)).status, 401);
  assert.deepEqual(
    await (await app.request('/v1/invitations', { headers: { authorization: `Bearer ${carol.token}` } })).json(),
    { invitations: [] },
  );
  assert.equal((await me(keptAgent.token)).status, 200);
  const clans = await (await app.request('/v1/clans', { headers: { authorization: `Bearer ${bob.token}` } })).json();
  assert.deepEqual(clans.clans, []);
});
