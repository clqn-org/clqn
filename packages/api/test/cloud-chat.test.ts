import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { chatInfoSchema, defaultChatSettings } from '@clqn/shared';
import { createApp } from '../src/app.js';
import { claimCloudChat, cloudChatContext, finishCloudChat, retryCloudChat } from '../src/db/cloud-chat.js';
import { database, skip } from './postgres.js';

test('cloud leases fence duplicate turns and scope worker presence to a clan and its owners', { skip }, async (t) => {
  const { sql, connection, user } = await database(t);
  const { db, store } = connection;
  const [leader, member, outsider] = await Promise.all([user(), user(), user()]);
  const clan = await store.createClan(leader.user.id, 'Cloud queue');
  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${member.user.id})`;
  const [worker, offline, coordinator] = await Promise.all([
    store.registerAgent(member.user, clan.id, 'Member worker'),
    store.registerAgent(leader.user, clan.id, 'Leader worker'),
    store.registerAgent(leader.user, clan.id, 'Old coordinator', 'orchestrator'),
  ]);
  const app = createApp(store, db, { cloudOrchestrator: true });
  const chat = (token: string, path: string, body?: object) =>
    app.request(`/v1/clans/${clan.id}/chat${path}`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const send = async (text: string, replyTo?: string) => {
    const id = randomUUID();
    assert.equal((await chat(member.token, '/messages', { id, text, replyTo })).status, 201);
    return id;
  };

  const info = chatInfoSchema.parse(await (await chat(member.token, '')).json());
  assert.equal(info.cloudOrchestrator, true);
  assert.equal(info.canStart, false);
  assert.equal(info.session, null);
  assert.equal((await chat(outsider.token, '/join', defaultChatSettings)).status, 404);
  assert.equal((await chat(member.token, '/join', { ...defaultChatSettings, tokenLimit: 500 })).status, 200);
  assert.equal((await chat(leader.token, '/join', defaultChatSettings)).status, 200);
  assert.equal((await chat(coordinator.token, '/inbox', {})).status, 403);
  const presence = (token: string, ...agentIds: string[]) => chat(token, '/workers/presence', { agentIds });
  assert.equal((await presence(worker.token, worker.agent.id)).status, 403);
  assert.equal((await presence(outsider.token, worker.agent.id)).status, 404);
  assert.equal((await presence(member.token, worker.agent.id, offline.agent.id)).status, 403);
  assert.equal((await presence(leader.token, coordinator.agent.id)).status, 403);
  assert.equal((await presence(leader.token, offline.agent.id)).status, 200);
  await sql`update cloud_worker_presence set seen_at = now() - interval '1 minute' where agent_id = ${offline.agent.id}`;
  const id = await send('Implement the first change');
  const secondId = await send('Implement the second change');
  assert.equal(
    (await chat(coordinator.token, `/messages/${id}/decision`, { action: 'reply', text: 'No' })).status,
    403,
  );

  const claim = () => claimCloudChat(db, 10_000);
  const claims = (await Promise.all([claim(), claim()])).filter((entry) => entry !== null);
  assert.equal(claims.length, 1);
  const first = claims[0]!;
  assert.equal(first.messageId, id);
  assert.deepEqual((await cloudChatContext(db, first))?.workers, []);
  assert.equal((await presence(member.token, worker.agent.id, worker.agent.id)).status, 200);
  assert.deepEqual(
    (await cloudChatContext(db, first))?.workers.map(({ id, availableTokens }) => [id, availableTokens]),
    [[worker.agent.id, 500]],
  );
  const decision = { action: 'clarify', text: 'Which platform?' } as const;
  await sql`update chats set cloud_lease_expires_at = now() - interval '1 second' where clan_id = ${clan.id}`;
  assert.equal(await finishCloudChat(db, first, decision), false);
  const recovered = await claim();
  assert.ok(recovered);
  assert.equal(recovered.messageId, id);
  assert.equal(recovered.attempt, 2);
  assert.equal(await retryCloudChat(db, first), false);
  assert.equal(await retryCloudChat(db, recovered), true);
  assert.equal(await claim(), null);
  await sql`update chats set cloud_retry_at = now() - interval '1 second' where clan_id = ${clan.id}`;
  const retried = await claim();
  assert.ok(retried);
  assert.equal(retried.attempt, 3);
  assert.equal(await finishCloudChat(db, retried, decision), true);
  assert.equal(await finishCloudChat(db, retried, decision), false);
  const second = await claim();
  assert.ok(second);
  assert.equal(second.messageId, secondId);
  assert.equal(second.attempt, 1);
  assert.equal(await finishCloudChat(db, second, { action: 'reply', text: 'Second response' }), true);

  for (let i = 0; i < 17; i++) await send(`An additional message ${i}`);
  await sql`update chat_messages set status = 'handled' where clan_id = ${clan.id} and status = 'queued'`;
  const answerId = await send('macOS', id);
  const answer = await claim();
  assert.ok(answer);
  assert.equal(answer.messageId, answerId);
  const context = await cloudChatContext(db, answer);
  assert.equal(context?.related?.id, id);
  assert.equal(context?.question, decision.text);
  assert.ok(context?.messages.every((message) => message.id !== id));
  assert.equal(
    await finishCloudChat(db, answer, {
      action: 'delegate',
      title: 'Implement the macOS change',
      description: 'Make the agreed change for macOS.',
      workerId: worker.agent.id,
      estimatedTokens: 100,
    }),
    true,
  );
});

test('cloud call limits are shared across clans and reset next hour', { skip }, async (t) => {
  const { sql, connection, user } = await database(t);
  const { db, store } = connection;
  const app = createApp(store, db, { cloudOrchestrator: true });
  for (let i = 0; i < 2; i++) {
    const leader = await user();
    const clan = await store.createClan(leader.user.id, `Cloud quota ${i}`);
    const request = (path: string, body: object) =>
      app.request(`/v1/clans/${clan.id}/chat/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${leader.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    assert.equal((await request('join', defaultChatSettings)).status, 200);
    assert.equal((await request('messages', { id: randomUUID(), text: 'Hello' })).status, 201);
  }
  await sql`delete from cloud_chat_quota`;
  try {
    const claims = (await Promise.all([claimCloudChat(db, 1), claimCloudChat(db, 1)])).filter(
      (entry) => entry !== null,
    );
    assert.equal(claims.length, 1);
    assert.equal(await claimCloudChat(db, 1), null);
    await sql`update cloud_chat_quota set hour = hour - interval '1 hour'`;
    const next = await claimCloudChat(db, 1);
    assert.ok(next);
    assert.notEqual(next.clanId, claims[0]?.clanId);
  } finally {
    await sql`delete from cloud_chat_quota`;
  }
});
