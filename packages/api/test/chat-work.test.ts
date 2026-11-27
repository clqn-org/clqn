import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  type ChatDecision,
  type ChatRouteRequest,
  chatFollowupsSchema,
  chatInboxSchema,
  chatStateSchema,
  defaultChatSettings,
} from '@clqn/shared';
import { createApp } from '../src/app.js';
import { database, skip } from './postgres.js';

async function read<T>(pending: Response | Promise<Response>, schema: { parse(value: unknown): T }) {
  const response = await pending;
  assert.equal(response.status, 200, await response.clone().text());
  return schema.parse(await response.json());
}

test('PostgreSQL: independent chat work, clarification, and follow-ups to the active worker', { skip }, async (t) => {
  const { connection, sql, user } = await database(t);
  const [leader, member] = await Promise.all([user(), user()]);
  const clan = await connection.store.createClan(leader.user.id, 'Parallel chat');
  const otherClan = await connection.store.createClan(leader.user.id, 'Other chat');
  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${member.user.id})`;
  const host = await connection.store.registerAgent(leader.user, clan.id, 'Host', 'orchestrator');
  const worker = await connection.store.registerAgent(member.user, clan.id, 'Worker');
  const otherWorker = await connection.store.registerAgent(member.user, clan.id, 'Other worker');
  const app = createApp(connection.store, connection.db);
  const lease = randomUUID();
  const request = (token: string, path: string, body?: object, clanId = clan.id) =>
    app.request(`/v1/clans/${clanId}${path}`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const chat = (token: string, path: string, body?: object) => request(token, `/chat${path}`, body);
  const state = () => read(chat(member.token, '/state'), chatStateSchema);
  const inbox = (workId?: string) =>
    read(chat(host.token, `/inbox?lease=${lease}${workId ? `&work=${workId}` : ''}`, {}), chatInboxSchema);
  const route = (id: string, body: ChatRouteRequest, token = host.token, leaseId = lease) =>
    chat(token, `/messages/${id}/route?lease=${leaseId}`, body);
  const decide = (id: string, decision: ChatDecision, pickId?: string | null) =>
    chat(host.token, `/messages/${id}/decision?lease=${lease}`, { ...decision, pickId: pickId ?? undefined });
  const delegate = {
    action: 'delegate',
    title: 'Fix fetch retries',
    description: 'Keep fetch attempts bounded.',
    workerId: worker.agent.id,
    estimatedTokens: 20,
  } as const;
  async function send(text: string, options?: { replyTo?: string; force?: boolean }) {
    const message = { id: randomUUID(), text, ...options };
    assert.equal((await chat(member.token, '/messages', message)).status, 201);
    return message;
  }

  for (const { token } of [leader, member]) {
    assert.equal((await chat(token, '/join', defaultChatSettings)).status, 200);
  }
  assert.equal((await request(leader.token, '/chat/join', defaultChatSettings, otherClan.id)).status, 200);
  const otherWork = randomUUID();
  await sql`insert into chat_messages (clan_id, id, author_id, author, role, text, status, work_id, work_title)
    values (${otherClan.id}, ${otherWork}, ${leader.user.id}, 'Orchestrator', 'orchestrator', 'Other work.',
      'queued', ${otherWork}, 'Other work')`;
  assert.equal((await chat(host.token, '/host/heartbeat', { leaseId: lease })).status, 200);
  assert.equal((await chat(host.token, `/inbox?lease=${lease}&work=${otherWork}`, {})).status, 404);
  const original = await send('Fix fetch retries and add a status command');
  const parent = await inbox();
  assert.equal(parent.next?.id, original.id);
  const start = {
    action: 'start',
    work: [
      { title: 'Fetch retries', description: 'Fix fetch retries.' },
      { title: 'Status command', description: 'Add a status command.' },
    ],
    pickId: parent.pickId!,
  } as const;
  const startRequest: ChatRouteRequest = { ...start, work: [...start.work] };
  assert.equal((await route(original.id, startRequest, worker.token)).status, 403);
  assert.equal((await route(original.id, startRequest, host.token, randomUUID())).status, 409);
  const attempts = await Promise.all([route(original.id, startRequest), route(original.id, startRequest)]);
  assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 409]);
  const { work } = await state();
  assert.equal(work?.pending, null);
  assert.equal(work?.ready.length, 2);
  const [first, second] = work!.ready as [string, string];
  const [firstPick, secondPick] = await Promise.all([inbox(first), inbox(second)]);
  assert.equal(firstPick.next?.id, first);
  assert.equal(secondPick.next?.id, second);
  assert.equal(firstPick.workItem?.title, 'Fetch retries');
  assert.deepEqual(
    firstPick.messages.map(({ id }) => id),
    [first],
  );
  assert.deepEqual(
    secondPick.messages.map(({ id }) => id),
    [second],
  );

  const unrelated = await send('How does chat work?', { force: true });
  const router = await inbox();
  assert.equal(router.next?.id, unrelated.id);
  assert.deepEqual(
    router.work?.map(({ id, requestId, position }) => [id, requestId, position]),
    [
      [first, original.id, 1],
      [second, original.id, 2],
    ],
  );
  assert.equal(
    (await route(unrelated.id, { action: 'reply', text: 'Each task has its own context.', pickId: router.pickId! }))
      .status,
    200,
  );
  const holdOther = await decide(first, { action: 'clarify', text: 'Which?', hold: second }, firstPick.pickId);
  assert.equal(holdOther.status, 409);
  assert.equal((await decide(first, delegate)).status, 409);
  assert.equal((await decide(first, delegate, firstPick.pickId)).status, 200);
  assert.equal(
    (await decide(second, { action: 'clarify', text: 'Which status fields should it show?' }, secondPick.pickId))
      .status,
    200,
  );
  const answer = await send('Show uptime', { replyTo: second });
  const scopedAnswer = await inbox(second);
  assert.equal(scopedAnswer.next?.id, answer.id);
  assert.equal(scopedAnswer.held[0]?.id, second);
  assert.equal((await inbox()).next, null);
  assert.equal((await decide(answer.id, { action: 'reply', text: 'Uptime it is.' }, scopedAnswer.pickId)).status, 200);

  async function followup(id: string) {
    const next = await inbox();
    assert.equal(next.next?.id, id);
    const response = await route(id, { action: 'followup', workId: first, pickId: next.pickId! });
    assert.equal(response.status, 200, await response.clone().text());
  }
  const update = await send('For task one, cap fetch retries at three.');
  const foreignWorkPick = await inbox();
  assert.equal(
    (await route(update.id, { action: 'followup', workId: otherWork, pickId: foreignWorkPick.pickId! })).status,
    404,
  );
  await followup(update.id);
  const waitingApproval = await state();
  assert.equal(waitingApproval.approvals.length, 1);
  assert.equal(waitingApproval.approvals[0]?.messageId, first);
  const approval = `/messages/${first}/approval`;
  assert.equal((await chat(leader.token, approval, { approve: true })).status, 403);
  assert.equal((await chat(member.token, approval, { approve: true })).status, 200);
  const run = (await state()).runs[0]!;
  const updatesPath = `/tasks/${run.taskId}/followups`;
  assert.equal((await chat(worker.token, updatesPath)).status, 403);
  assert.equal((await request(worker.token, `/tasks/${run.taskId}/claim`, {})).status, 200);
  assert.equal((await chat(member.token, updatesPath)).status, 403);
  assert.equal((await chat(otherWorker.token, updatesPath)).status, 403);
  assert.equal((await request(worker.token, `/chat${updatesPath}`, undefined, otherClan.id)).status, 404);
  const updates = (after: number) => read(chat(worker.token, `${updatesPath}?after=${after}`), chatFollowupsSchema);
  const received = await updates(0);
  assert.deepEqual(
    received.messages.map(({ id, text }) => ({ id, text })),
    [update],
  );
  assert.deepEqual(await updates(received.next), { messages: [], next: received.next });

  const scopedUpdate = await inbox(first);
  assert.equal(scopedUpdate.next?.id, update.id);
  assert.equal(scopedUpdate.workItem?.status, 'running');
  assert.equal((await decide(update.id, delegate, scopedUpdate.pickId)).status, 409);
  assert.equal(
    (await decide(update.id, { action: 'reply', text: 'Forwarded to the worker.' }, scopedUpdate.pickId)).status,
    200,
  );
  assert.equal((await state()).runs.length, 1);

  const earlier = await send('Task one also needs a timeout test.');
  const urgent = await send('Task one should time out at two seconds.', { force: true });
  await followup(urgent.id);
  const urgentDelivery = await updates(received.next);
  assert.deepEqual(
    urgentDelivery.messages.map(({ id }) => id),
    [urgent.id],
  );
  await followup(earlier.id);
  const earlierDelivery = await updates(urgentDelivery.next);
  assert.deepEqual(
    earlierDelivery.messages.map(({ id }) => id),
    [earlier.id],
  );
  for (const id of [urgent.id, earlier.id]) {
    const picked = await inbox(first);
    assert.equal(picked.next?.id, id);
    assert.equal((await decide(id, { action: 'reply', text: 'Updated the worker.' }, picked.pickId)).status, 200);
  }

  assert.equal((await request(worker.token, `/tasks/${run.taskId}/release`, {})).status, 200);
  const continuation = await send('Resume task one and keep the two-second timeout.');
  await followup(continuation.id);
  const stopped = await inbox(first);
  assert.equal(stopped.next?.id, continuation.id);
  assert.equal(stopped.workItem?.status, 'released');
  assert.equal(stopped.workItem?.taskId, run.taskId);
  assert.equal(stopped.workItem?.workerId, worker.agent.id);
  const resume = { ...delegate, taskId: run.taskId, description: 'Resume and keep the two-second timeout.' };
  assert.equal(
    (await decide(continuation.id, { ...resume, workerId: otherWorker.agent.id }, stopped.pickId)).status,
    409,
  );

  const differentWork = await send('For task two, add a version field.', { replyTo: answer.id });
  const differentPick = await inbox(second);
  assert.equal(differentPick.next?.id, differentWork.id);
  assert.equal((await decide(differentWork.id, resume, differentPick.pickId)).status, 409);
  assert.equal((await decide(continuation.id, resume, stopped.pickId)).status, 200);
  assert.equal((await state()).approvals[0]?.messageId, continuation.id);

  // The continued session receives follow-ups after the approved continuation, including updates while awaiting yes.
  const later = await send('On task one, document the timeout default too.');
  await followup(later.id);
  const stillWaiting = await inbox(first);
  assert.equal(stillWaiting.workItem?.status, 'approval');
  assert.equal(stillWaiting.next?.id, later.id);
  assert.equal((await decide(later.id, resume, stillWaiting.pickId)).status, 409);
  assert.equal((await chat(member.token, `/messages/${continuation.id}/approval`, { approve: true })).status, 200);
  const continued = (await state()).runs.find(({ taskId }) => taskId === run.taskId);
  assert.equal(continued?.messageId, continuation.id);
  assert.equal(continued?.workerId, worker.agent.id);
  assert.equal((await request(worker.token, `/tasks/${run.taskId}/claim`, {})).status, 200);
  const afterContinuation = await updates(0);
  assert.deepEqual(
    afterContinuation.messages.map(({ id }) => id),
    [later.id],
  );
  const resumed = await inbox(first);
  assert.equal(resumed.workItem?.id, first);
  assert.equal(resumed.workItem?.taskId, run.taskId);
  assert.equal(resumed.workItem?.status, 'running');
  assert.equal((await request(worker.token, `/tasks/${run.taskId}/complete`, {})).status, 200);
  assert.equal((await chat(worker.token, updatesPath)).status, 403);

  // A task assigned by an older host keeps the same claimant when its first update is routed.
  const legacy = await send('Add export support');
  const legacyDecision = { ...delegate, title: 'Export support', workerId: otherWorker.agent.id };
  assert.equal((await decide(legacy.id, legacyDecision)).status, 200);
  assert.equal((await chat(member.token, `/messages/${legacy.id}/approval`, { approve: true })).status, 200);
  const legacyRun = (await state()).runs.find(({ messageId }) => messageId === legacy.id)!;
  assert.equal((await request(otherWorker.token, `/tasks/${legacyRun.taskId}/claim`, {})).status, 200);
  const legacyUpdate = await send('For export support, use JSON.');
  const legacyRoute = await inbox();
  assert.equal(legacyRoute.work?.find(({ id }) => id === legacy.id)?.status, 'running');
  assert.equal(
    (await route(legacyUpdate.id, { action: 'followup', workId: legacy.id, pickId: legacyRoute.pickId! })).status,
    200,
  );
  const delivered = await read(chat(otherWorker.token, `/tasks/${legacyRun.taskId}/followups`), chatFollowupsSchema);
  assert.deepEqual(
    delivered.messages.map(({ id }) => id),
    [legacyUpdate.id],
  );
  assert.equal((await state()).runs.find(({ messageId }) => messageId === legacy.id)?.taskId, legacyRun.taskId);

  const beforeFailover = await inbox(legacy.id);
  assert.equal(beforeFailover.next?.id, legacyUpdate.id);
  const reply = { action: 'reply', text: 'Use JSON.' } as const;
  await sql`update chats set lease_expires_at = clock_timestamp() - interval '1 second' where clan_id = ${clan.id}`;
  assert.equal((await decide(legacyUpdate.id, reply, beforeFailover.pickId)).status, 409);
  assert.equal((await chat(host.token, `/inbox?work=${legacy.id}`, {})).status, 409);
  const newLease = randomUUID();
  assert.equal((await chat(host.token, '/host/heartbeat', { leaseId: newLease })).status, 200);
  const recovered = await read(chat(host.token, `/inbox?lease=${newLease}&work=${legacy.id}`, {}), chatInboxSchema);
  assert.equal(recovered.next?.id, legacyUpdate.id);
  assert.notEqual(recovered.pickId, beforeFailover.pickId);
  assert.equal(
    (
      await chat(host.token, `/messages/${legacyUpdate.id}/decision?lease=${newLease}`, {
        ...reply,
        pickId: recovered.pickId,
      })
    ).status,
    200,
  );
});
