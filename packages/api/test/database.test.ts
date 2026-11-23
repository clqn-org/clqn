import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { sourceNodeArgs } from '../../../scripts/test-node.js';
import { createApp } from '../src/app.js';
import { createStore, hashToken } from '../src/store.js';

// Use a dedicated database: migrations are applied, and only this test's users/clans are deleted.
test('PostgreSQL: identity, clan isolation, concurrent creation, and credential revocation', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const url = process.env.TEST_DATABASE_URL!;
  const sql = postgres(url, { max: 2 });
  const connection = createStore(url);
  const userIds: string[] = [];
  t.after(async () => {
    try {
      if (userIds.length) {
        await sql`delete from events where actor_id in ${sql(userIds)}`;
        await sql`delete from invitations where created_by in ${sql(userIds)}`;
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
  const email = `${randomUUID()}@example.com`;
  const alice = await connection.provisionUser(email);
  userIds.push(alice.user.id);
  const bob = await connection.provisionUser(`${randomUUID()}@example.com`);
  userIds.push(bob.user.id);
  const second = await connection.provisionUser(email);
  assert.equal(second.user.id, alice.user.id);
  const [stored] = await sql`select token_hash from credentials where id = ${alice.credentialId}`;
  assert.equal(stored?.token_hash, hashToken(alice.token));
  assert.notEqual(stored?.token_hash, alice.token);
  const app = createApp(connection.store, connection.db);
  const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const create = (token: string, name: string) =>
    app.request('/v1/clans', { method: 'POST', headers: auth(token), body: JSON.stringify({ name }) });
  const responses = await Promise.all([
    create(alice.token, 'Alice one'),
    create(alice.token, 'Alice two'),
    create(bob.token, 'Bob'),
  ]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [201, 201, 201],
  );
  const [one, two, other] = await Promise.all(responses.map((r) => r.json()));
  assert.notEqual(one.id, two.id);
  assert.equal(one.createdBy, alice.user.id);
  const list = await app.request('/v1/clans', { headers: auth(alice.token) });
  assert.deepEqual(new Set((await list.json()).clans.map((c: { id: string }) => c.id)), new Set([one.id, two.id]));
  const members = await app.request(`/v1/clans/${one.id}/members`, { headers: auth(alice.token) });
  const [{ createdAt, ...leader }] = (await members.json()).members;
  assert.ok(Date.parse(createdAt));
  assert.deepEqual(leader, { userId: alice.user.id, email, role: 'leader' });
  for (const clanId of [other.id, randomUUID()]) {
    const response = await app.request(`/v1/clans/${clanId}/members`, { headers: auth(alice.token) });
    assert.equal(response.status, 404);
  }
  await assert.rejects(sql`insert into memberships (clan_id, user_id) values (${one.id}, ${alice.user.id})`, {
    code: '23505',
  });
  // A failed write must not leave a clan behind.
  const rollbackName = `rollback-${randomUUID()}`;
  await assert.rejects(
    connection.store.createClan(randomUUID(), rollbackName),
    (error) => (error as { cause?: { code?: string } }).cause?.code === '23503',
  );
  const [count] = await sql`select count(*)::integer as n from clans where name = ${rollbackName}`;
  assert.equal(count?.n, 0);
  // Invitations must be leader-only, email-bound, expiring, and single-use under contention.
  const invite = (token: string, clanId: string, email: string) =>
    app.request(`/v1/clans/${clanId}/invitations`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ email }),
    });
  const joinClan = (token: string, code: string) =>
    app.request('/v1/invitations/join', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ code }),
    });
  assert.equal((await invite(bob.token, one.id, bob.user.email)).status, 404);
  const invitationResponse = await invite(alice.token, one.id, ` ${bob.user.email.toUpperCase()} `);
  assert.equal(invitationResponse.status, 201);
  const invitation = await invitationResponse.json();
  assert.equal(invitation.email, bob.user.email);
  const [storedInvite] = await sql`select code_hash from invitations where code_hash = ${hashToken(invitation.code)}`;
  assert.equal(storedInvite?.code_hash, hashToken(invitation.code));
  assert.equal((await joinClan(alice.token, invitation.code)).status, 404);
  const joins = await Promise.all([joinClan(bob.token, invitation.code), joinClan(bob.token, invitation.code)]);
  assert.deepEqual(joins.map((r) => r.status).sort(), [200, 404]);
  const joinedMembers = await app.request(`/v1/clans/${one.id}/members`, { headers: auth(bob.token) });
  assert.equal((await joinedMembers.json()).members.length, 2);
  assert.equal((await invite(bob.token, one.id, alice.user.email)).status, 404);
  const duplicate = await (await invite(alice.token, one.id, bob.user.email)).json();
  assert.equal((await joinClan(bob.token, duplicate.code)).status, 409);
  const [unconsumed] = await sql`select consumed_at from invitations where code_hash = ${hashToken(duplicate.code)}`;
  assert.equal(unconsumed?.consumed_at, null);
  const expired = await (await invite(alice.token, two.id, bob.user.email)).json();
  await sql`update invitations set expires_at = now() - interval '1 second' where code_hash = ${hashToken(expired.code)}`;
  assert.equal((await joinClan(bob.token, expired.code)).status, 404);
  const [joinedEvents] =
    await sql`select count(*)::integer as n from events where clan_id = ${one.id} and type = 'member.joined'`;
  assert.equal(joinedEvents?.n, 1);
  // Agents inherit the human identity but have an independent, clan-scoped credential.
  const register = (token: string, clanId: string, name: string) =>
    app.request(`/v1/clans/${clanId}/agents`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ name }),
    });
  assert.equal((await register(bob.token, two.id, 'Outsider')).status, 404);
  const registrationResponse = await register(alice.token, one.id, 'Codex');
  assert.equal(registrationResponse.status, 201);
  const registration = await registrationResponse.json();
  assert.equal(registration.agent.ownerId, alice.user.id);
  const [agentCredential] = await sql`select id, token_hash from credentials where agent_id = ${registration.agent.id}`;
  assert.equal(agentCredential?.token_hash, hashToken(registration.token));
  const actor = await connection.store.authenticate(hashToken(registration.token));
  assert.deepEqual(actor, { ...alice.user, agentId: registration.agent.id, clanId: one.id });
  const current = await app.request('/v1/agent', { headers: auth(registration.token) });
  assert.deepEqual(await current.json(), registration.agent);
  assert.equal((await app.request(`/v1/clans/${one.id}/members`, { headers: auth(registration.token) })).status, 200);
  assert.equal((await app.request(`/v1/clans/${two.id}/members`, { headers: auth(registration.token) })).status, 404);
  const agentClans = await app.request('/v1/clans', { headers: auth(registration.token) });
  assert.deepEqual(
    (await agentClans.json()).clans.map((c: { id: string }) => c.id),
    [one.id],
  );
  assert.equal((await register(registration.token, one.id, 'Nested')).status, 403);
  assert.equal((await invite(registration.token, one.id, bob.user.email)).status, 403);
  assert.equal((await create(registration.token, 'Forbidden')).status, 403);
  assert.equal(await connection.revokeCredential(agentCredential?.id), true);
  assert.equal((await app.request('/v1/agent', { headers: auth(registration.token) })).status, 401);
  const bobAgent = await (await register(bob.token, one.id, 'Claude')).json();
  await sql`delete from memberships where clan_id = ${one.id} and user_id = ${bob.user.id}`;
  assert.equal((await app.request('/v1/agent', { headers: auth(bobAgent.token) })).status, 401);
  // Exercise the built CLI against a real HTTP server and migrated PostgreSQL.
  const directory = await mkdtemp(join(tmpdir(), 'clqn-postgres-'));
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve(listener));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const env: NodeJS.ProcessEnv = { ...process.env, CLQN_CONFIG_DIR: directory };
  delete env.CLQN_TOKEN;
  const runCli = (args: string[], input?: string) => {
    const command = promisify(execFile)(
      process.execPath,
      [
        ...sourceNodeArgs,
        fileURLToPath(new URL('../../cli/src/index.ts', import.meta.url)),
        '--api-url',
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        '--json',
        ...args,
      ],
      { env },
    );
    command.child.stdin?.end(input);
    return command.then(({ stdout }) => JSON.parse(stdout));
  };
  assert.deepEqual(await runCli(['login'], alice.token), alice.user);
  const cliClan = await runCli(['init', 'CLI project']);
  assert.equal(cliClan.createdBy, alice.user.id);
  assert.equal((await runCli(['members'])).members[0].role, 'leader');
  const cliInvite = await runCli(['invite', bob.user.email]);
  // Logout revokes the saved token on the server, not just the local copy.
  assert.equal((await runCli(['logout'])).tokenRevoked, true);
  await runCli(['login'], bob.token);
  assert.equal((await runCli(['join', cliInvite.code])).id, cliClan.id);
  assert.equal((await runCli(['members'])).members.length, 2);
  assert.equal((await runCli(['logout'])).credentialsRemoved, true);
  assert.equal(await connection.revokeCredential(alice.credentialId), false);
  const denied = await app.request('/v1/me', { headers: auth(alice.token) });
  assert.equal(denied.status, 401);
  const allowed = await app.request('/v1/me', { headers: auth(second.token) });
  assert.equal(allowed.status, 200);
});
