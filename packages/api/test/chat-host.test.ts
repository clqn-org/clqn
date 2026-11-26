import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { chatInboxSchema, chatLeaseSchema, chatStateSchema, defaultChatSettings } from '@clqn/shared';
import { createApp } from '../src/app.js';
import { database, skip } from './postgres.js';

test('PostgreSQL: chat host takeover keeps the queue and fences expired, released and removed hosts', {
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
  const nominate = (token: string, userId: string | null) => request(token, '/chat/host/backup', { userId });
  const register = (token: string, name: string) => request(token, '/agents', { name, role: 'orchestrator' });
  const state = async (token = leader.token) =>
    chatStateSchema.parse(await (await request(token, '/chat/state')).json());
  const lease = async (token: string, leaseId: string, action = 'heartbeat') => {
    const response = await request(token, `/chat/host/${action}`, { leaseId });
    assert.equal(response.status, 200, await response.clone().text());
    return chatLeaseSchema.parse(await response.json()).active;
  };
  const inbox = (token: string, leaseId?: string) =>
    request(token, `/chat/inbox${leaseId ? `?lease=${leaseId}` : ''}`, {});
  const reply = (token: string, leaseId: string, id: string, text: string) =>
    request(token, `/chat/messages/${id}/decision?lease=${leaseId}`, { action: 'reply', text });

  const primary = await connection.store.registerAgent(leader.user, clan.id, 'Leader’s orchestrator', 'orchestrator');
  const worker = await connection.store.registerAgent(leader.user, clan.id, 'Leader’s worker');
  for (const { token } of [leader, backup, member]) {
    assert.equal((await request(token, '/chat/join', defaultChatSettings)).status, 200);
  }
  assert.equal((await inbox(primary.token)).status, 200);
  assert.equal((await nominate(backup.token, member.user.id)).status, 403);
  assert.equal((await nominate(primary.token, backup.user.id)).status, 403);
  assert.equal((await nominate(leader.token, leader.user.id)).status, 400);
  assert.equal((await nominate(leader.token, outsider.user.id)).status, 404);
  assert.equal((await register(backup.token, 'Before nomination')).status, 403);
  assert.deepEqual(await (await nominate(leader.token, backup.user.id)).json(), { backupUserId: backup.user.id });
  assert.equal((await state()).orchestration?.eligible, true);
  assert.equal((await state(backup.token)).orchestration?.eligible, true);
  assert.equal((await state(member.token)).orchestration?.eligible, false);
  const standby = await connection.store.registerAgent(backup.user, clan.id, 'Backup orchestrator', 'orchestrator');
  assert.equal((await register(backup.token, 'Duplicate backup')).status, 409);
  assert.equal((await register(member.token, 'Unappointed member')).status, 403);
  const firstLease = randomUUID();
  const anotherProcess = randomUUID();
  const standbyLease = randomUUID();
  for (const token of [leader.token, worker.token]) {
    assert.equal((await request(token, '/chat/host/heartbeat', { leaseId: firstLease })).status, 403);
  }
  assert.equal((await inbox(primary.token)).status, 409);
  const raced = await Promise.all([lease(primary.token, firstLease), lease(primary.token, anotherProcess)]);
  assert.deepEqual([...raced].sort(), [false, true]);
  const heldLease = raced[0] ? firstLease : anotherProcess;
  assert.equal(await lease(standby.token, standbyLease), false);
  assert.equal(await lease(primary.token, heldLease), true);
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

  assert.equal(await lease(standby.token, standbyLease, 'release'), false);
  assert.equal(await lease(standby.token, standbyLease), false);
  const promotedLease = randomUUID();
  assert.equal(await lease(standby.token, promotedLease), true);
  assert.equal((await request(leader.token, '/leader', { userId: backup.user.id })).status, 200);
  assert.deepEqual((await state(backup.token)).orchestration, { backupUserId: null, eligible: true, activeHost: null });
  assert.equal((await inbox(primary.token, heldLease)).status, 403);
  assert.equal((await inbox(standby.token, promotedLease)).status, 409);
  assert.equal((await inbox(standby.token)).status, 200);
  const newLeaderLease = randomUUID();
  assert.equal(await lease(standby.token, newLeaderLease), true);

  assert.equal((await nominate(backup.token, member.user.id)).status, 200);
  const successor = await connection.store.registerAgent(member.user, clan.id, 'Next backup', 'orchestrator');
  // The new nomination and its removal don't disturb the incumbent leader.
  const successorLease = randomUUID();
  assert.equal(await lease(successor.token, successorLease), false);
  assert.equal((await request(member.token, '/leave', {})).status, 200);
  assert.deepEqual((await state(backup.token)).orchestration, {
    backupUserId: null,
    eligible: true,
    activeHost: backup.user.email,
  });
  assert.equal((await request(successor.token, '/chat/host/heartbeat', { leaseId: successorLease })).status, 401);

  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${outsider.user.id})`;
  assert.equal((await nominate(backup.token, outsider.user.id)).status, 200);
  const lastBackup = await connection.store.registerAgent(outsider.user, clan.id, 'Another backup', 'orchestrator');
  await lease(standby.token, newLeaderLease, 'release');
  const lastLease = randomUUID();
  assert.equal(await lease(lastBackup.token, lastLease), true);
  assert.equal((await state(backup.token)).orchestration?.activeHost, outsider.user.email);
  assert.equal((await request(backup.token, `/members/${outsider.user.id}/remove`, {})).status, 200);
  assert.deepEqual((await state(backup.token)).orchestration, { backupUserId: null, eligible: true, activeHost: null });
  assert.equal((await inbox(lastBackup.token, lastLease)).status, 401);
});
