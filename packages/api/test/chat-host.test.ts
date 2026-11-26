import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { chatInboxSchema, chatLeaseSchema, chatStateSchema, defaultChatSettings } from '@clqn/shared';
import { createApp } from '../src/app.js';
import { database, skip } from './postgres.js';

test('PostgreSQL: multiple chat backups share one lease and recover queued work', {
  skip,
}, async (t) => {
  const { sql, connection, user } = await database(t);
  const [leader, backup, member, outsider] = await Promise.all([user(), user(), user(), user()]);
  const clan = await connection.store.createClan(leader.user.id, 'Chat failover');
  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${backup.user.id}), (${clan.id}, ${member.user.id})`;
  const app = createApp(connection.store, connection.db);
  const request = (token: string, path: string, body?: object) =>
    app.request(`/v1/clans/${clan.id}${path}`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
  const nominate = (token: string, ...userIds: string[]) => request(token, '/chat/host/backups', { userIds });
  const backups = (token = leader.token) => request(token, '/chat/host/backups');
  const register = (token: string, name: string) => request(token, '/agents', { name, role: 'orchestrator' });
  const state = async (token = leader.token) =>
    chatStateSchema.parse(await (await request(token, '/chat/state')).json());
  const lease = async (token: string, leaseId: string, action = 'heartbeat', renew?: boolean) => {
    const response = await request(token, `/chat/host/${action}`, { leaseId, renew });
    assert.equal(response.status, 200, await response.clone().text());
    return chatLeaseSchema.parse(await response.json()).active;
  };
  const inbox = (token: string, leaseId?: string) =>
    request(token, `/chat/inbox${leaseId ? `?lease=${leaseId}` : ''}`, {});
  const reply = (token: string, leaseId: string, id: string, text: string) =>
    request(token, `/chat/messages/${id}/decision?lease=${leaseId}`, { action: 'reply', text });

  const primary = await connection.store.registerAgent(leader.user, clan.id, 'Leader’s orchestrator', 'orchestrator');
  const worker = await connection.store.registerAgent(leader.user, clan.id, 'Leader’s worker');
  assert.deepEqual(await (await backups()).json(), { userIds: [] });
  assert.equal((await backups(backup.token)).status, 403);
  assert.equal((await backups(primary.token)).status, 403);
  assert.equal((await backups(outsider.token)).status, 404);
  assert.equal((await nominate(backup.token, member.user.id)).status, 403);
  assert.equal((await nominate(primary.token, backup.user.id)).status, 403);
  assert.equal((await nominate(leader.token, leader.user.id)).status, 400);
  assert.equal((await nominate(leader.token, backup.user.id, outsider.user.id)).status, 404);
  assert.equal((await register(backup.token, 'Before nomination')).status, 403);
  assert.deepEqual(await (await backups()).json(), { userIds: [] });
  const requested = [backup.user.id, member.user.id].sort();
  assert.deepEqual(await (await nominate(leader.token, ...requested, backup.user.id)).json(), { userIds: requested });
  for (const { token } of [leader, backup, member]) {
    assert.equal((await request(token, '/chat/join', defaultChatSettings)).status, 200);
  }
  assert.deepEqual(await (await backups()).json(), { userIds: requested });
  assert.deepEqual((await state()).orchestration, { backup: false, eligible: true, activeHost: null });
  assert.deepEqual((await state(backup.token)).orchestration, { backup: true, eligible: true, activeHost: null });
  assert.deepEqual((await state(member.token)).orchestration, { backup: true, eligible: true, activeHost: null });
  const standby = await connection.store.registerAgent(backup.user, clan.id, 'First backup', 'orchestrator');
  const second = await connection.store.registerAgent(member.user, clan.id, 'Second backup', 'orchestrator');
  assert.equal((await register(backup.token, 'Duplicate backup')).status, 409);
  const firstLease = randomUUID();
  const anotherProcess = randomUUID();
  const standbyLease = randomUUID();
  const secondLease = randomUUID();
  for (const token of [leader.token, worker.token]) {
    assert.equal((await request(token, '/chat/host/heartbeat', { leaseId: firstLease })).status, 403);
  }
  assert.equal((await inbox(primary.token)).status, 409);
  const raced = await Promise.all([lease(primary.token, firstLease), lease(primary.token, anotherProcess)]);
  assert.deepEqual([...raced].sort(), [false, true]);
  const heldLease = raced[0] ? firstLease : anotherProcess;
  assert.equal(await lease(standby.token, standbyLease), false);
  assert.equal(await lease(second.token, secondLease), false);
  assert.equal(await lease(primary.token, heldLease, 'heartbeat', true), true);
  assert.equal((await state()).orchestration?.activeHost, leader.user.email);

  const message = { id: randomUUID(), text: 'How does failover work?' };
  assert.equal((await request(member.token, '/chat/messages', message)).status, 201);
  assert.equal(chatInboxSchema.parse(await (await inbox(primary.token, heldLease)).json()).next?.id, message.id);
  await sql`update chats set lease_expires_at = clock_timestamp() - interval '1 second' where clan_id = ${clan.id}`;
  assert.equal((await state()).orchestration?.activeHost, null);
  assert.equal((await inbox(primary.token, heldLease)).status, 409);
  assert.equal((await reply(primary.token, heldLease, message.id, 'Stale')).status, 409);
  assert.equal(await lease(primary.token, heldLease), false);
  assert.equal(await lease(standby.token, standbyLease), true);
  assert.equal(await lease(second.token, secondLease), false);
  assert.equal((await state()).orchestration?.activeHost, backup.user.email);
  assert.equal(await lease(primary.token, heldLease, 'release'), false);
  assert.equal(chatInboxSchema.parse(await (await inbox(standby.token, standbyLease)).json()).next?.id, message.id);
  assert.equal((await reply(standby.token, standbyLease, message.id, 'Recovered')).status, 200);
  assert.equal((await reply(primary.token, heldLease, message.id, 'Still stale')).status, 409);
  assert.equal(chatInboxSchema.parse(await (await inbox(standby.token, standbyLease)).json()).next, null);
  assert.deepEqual(
    (await state()).messages.filter(({ replyTo }) => replyTo === message.id).map(({ text }) => text),
    ['Recovered'],
  );
  assert.equal(
    (await request(standby.token, `/tasks/${randomUUID()}/assign`, { agentId: worker.agent.id })).status,
    403,
  );

  const next = { id: randomUUID(), text: 'Does the second backup take over too?' };
  assert.equal((await request(member.token, '/chat/messages', next)).status, 201);
  assert.equal(chatInboxSchema.parse(await (await inbox(standby.token, standbyLease)).json()).next?.id, next.id);
  assert.equal(await lease(standby.token, standbyLease, 'release'), false);
  assert.equal(await lease(standby.token, standbyLease), false);
  assert.equal(await lease(second.token, secondLease), true);
  assert.equal(chatInboxSchema.parse(await (await inbox(second.token, secondLease)).json()).next?.id, next.id);

  // Removing one nomination keeps the other host's lease. Restoring a nomination does not take it away either.
  assert.deepEqual(await (await nominate(leader.token, member.user.id)).json(), { userIds: [member.user.id] });
  assert.equal((await inbox(standby.token, standbyLease)).status, 403);
  assert.equal((await state()).orchestration?.activeHost, member.user.email);
  assert.equal((await nominate(leader.token, ...requested)).status, 200);
  assert.equal((await request(leader.token, '/leader', { userId: backup.user.id })).status, 200);
  assert.equal((await backups()).status, 403);
  assert.deepEqual(await (await backups(backup.token)).json(), { userIds: [member.user.id] });
  assert.deepEqual((await state(backup.token)).orchestration, {
    backup: false,
    eligible: true,
    activeHost: member.user.email,
  });
  assert.equal((await inbox(primary.token, heldLease)).status, 403);
  assert.equal((await reply(second.token, secondLease, next.id, 'Second recovery')).status, 200);
  assert.equal(await lease(second.token, secondLease, 'release'), false);
  assert.equal(await lease(standby.token, standbyLease, 'heartbeat', true), false);
  const revokedLease = randomUUID();
  assert.equal(await lease(second.token, revokedLease), true);
  assert.deepEqual(await (await nominate(backup.token)).json(), { userIds: [] });
  assert.equal((await state(backup.token)).orchestration?.activeHost, null);
  assert.equal((await inbox(second.token, revokedLease)).status, 403);
  assert.equal((await nominate(backup.token, member.user.id)).status, 200);
  assert.equal(await lease(second.token, revokedLease, 'heartbeat', true), false);
  const finalLease = randomUUID();
  assert.equal(await lease(second.token, finalLease), true);

  // Removing the remaining active backup from membership fences its lease and restores legacy leader access.
  assert.equal((await request(member.token, '/leave', {})).status, 200);
  assert.deepEqual(await (await backups(backup.token)).json(), { userIds: [] });
  assert.deepEqual((await state(backup.token)).orchestration, { backup: false, eligible: true, activeHost: null });
  assert.equal((await inbox(second.token, finalLease)).status, 401);
  assert.equal((await inbox(standby.token)).status, 200);
});
