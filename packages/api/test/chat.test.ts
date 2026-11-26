import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  type ChatState,
  chatAttachmentFileSchema,
  chatInboxSchema,
  chatMetricsSchema,
  chatStateSchema,
  defaultChatSettings,
  type SendChat,
} from '@clqn/shared';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { database, skip } from './postgres.js';

test('PostgreSQL: force sends are FIFO and invalidate the interrupted turn', { skip }, async (t) => {
  const { connection, user } = await database(t);
  const [host, outsider] = await Promise.all([user(), user()]);
  const clan = await connection.store.createClan(host.user.id, 'Force send');
  const coordinator = await connection.store.registerAgent(host.user, clan.id, 'Coordinator', 'orchestrator');
  const app = createApp(connection.store, connection.db);
  const chat = (token: string, suffix: string, body?: object) =>
    app.request(`/v1/clans/${clan.id}/chat${suffix}`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  async function inbox() {
    const response = await chat(coordinator.token, '/inbox', {});
    assert.equal(response.status, 200, await response.clone().text());
    return chatInboxSchema.parse(await response.json());
  }
  const send = (message: SendChat) => chat(host.token, '/messages', message);
  const state = async () => chatStateSchema.parse(await (await chat(host.token, '/state')).json());
  const decide = (id: string, pickId?: string | null) =>
    chat(coordinator.token, `/messages/${id}/decision`, { action: 'reply', text: 'Handled', pickId });

  assert.equal((await chat(host.token, '/join', defaultChatSettings)).status, 200);
  const ordinary = { id: randomUUID(), text: 'Ordinary request' };
  const urgent = { id: randomUUID(), text: 'First urgent request', force: true };
  const next = { id: randomUUID(), text: 'Second urgent request', force: true };
  assert.equal((await send(ordinary)).status, 201);
  const interrupted = await inbox();
  assert.equal(interrupted.next?.id, ordinary.id);
  assert.ok(interrupted.pickId);
  assert.equal((await chat(outsider.token, '/messages', urgent)).status, 404);
  assert.equal((await chat(coordinator.token, '/messages', urgent)).status, 403);
  assert.deepEqual(
    (await Promise.all([send(urgent), send(urgent)])).map(({ status }) => status),
    [201, 201],
  );
  assert.equal((await send({ ...urgent, force: false })).status, 409);
  assert.deepEqual((await state()).forcePending, { id: urgent.id, processing: false });
  assert.equal((await state()).messages.find(({ id }) => id === ordinary.id)?.processing, undefined);
  assert.equal((await decide(ordinary.id, interrupted.pickId)).status, 409);
  assert.equal((await decide(ordinary.id)).status, 409);

  const first = await inbox();
  assert.equal(first.next?.id, urgent.id);
  assert.ok(first.pickId);
  assert.equal((await send(next)).status, 201);
  assert.deepEqual((await state()).forcePending, { id: urgent.id, processing: true });
  assert.equal((await decide(urgent.id, first.pickId)).status, 200);
  const second = await inbox();
  assert.equal(second.next?.id, next.id);
  assert.equal((await decide(next.id, second.pickId)).status, 200);

  const resumed = await inbox();
  assert.equal(resumed.next?.id, ordinary.id);
  assert.notEqual(resumed.pickId, interrupted.pickId);
  assert.equal((await decide(ordinary.id, interrupted.pickId)).status, 409);
  assert.equal((await send(urgent)).status, 201);
  assert.equal((await decide(ordinary.id, resumed.pickId)).status, 200);
  assert.equal((await state()).forcePending, null);
  assert.equal((await inbox()).next, null);
});

test('PostgreSQL: shared chat, held work, owner approvals, and competing delegations', {
  skip,
}, async (t) => {
  const { sql, connection, user: provision } = await database(t);
  const user = (name: string) => provision(`${name}-${randomUUID()}@example.com`);
  const [host, member, outsider] = await Promise.all([user('host'), user('member'), user('outsider')]);
  const clan = await connection.store.createClan(host.user.id, 'Docs refresh');
  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${member.user.id})`;
  const coordinator = await connection.store.registerAgent(host.user, clan.id, 'Coordinator', 'orchestrator');
  const worker = await connection.store.registerAgent(member.user, clan.id, 'Docs worker');
  const secondWorker = await connection.store.registerAgent(member.user, clan.id, 'Second worker');
  const app = createApp(connection.store, connection.db);
  const path = `/v1/clans/${clan.id}`;
  const chat = (token: string, suffix = '', body?: object) => request(token, `/chat${suffix}`, body);
  const request = (token: string, suffix: string, body?: object) =>
    app.request(path + suffix, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const state = async (token: string): Promise<ChatState> => {
    const response = await chat(token, '/state');
    assert.equal(response.status, 200, await response.clone().text());
    return chatStateSchema.parse(await response.json());
  };
  async function send(token: string, text: string, replyTo?: string) {
    const message: SendChat = { id: randomUUID(), text, replyTo };
    const response = await chat(token, '/messages', message);
    assert.equal(response.status, 201, await response.clone().text());
    return message;
  }
  const decision = (msg: SendChat, body: object) => chat(coordinator.token, `/messages/${msg.id}/decision`, body);
  const approve = (token: string, msg: SendChat, value = true) =>
    chat(token, `/messages/${msg.id}/approval`, { approve: value });
  const delegate = (msg: SendChat, workerId: string, estimatedTokens: number) =>
    decision(msg, {
      action: 'delegate',
      title: msg.text,
      description: msg.text,
      workerId,
      estimatedTokens,
    });

  assert.equal((await chat(outsider.token)).status, 404);
  assert.equal((await chat(outsider.token, '/state')).status, 404);
  assert.equal((await chat(member.token, '/join', defaultChatSettings)).status, 404);
  assert.equal((await chat(host.token, '/join', defaultChatSettings)).status, 200);
  assert.equal((await chat(member.token, '/state')).status, 403);
  assert.equal(
    (await chat(member.token, '/join', { ...defaultChatSettings, agentLimit: 1, tokenLimit: 100 })).status,
    200,
  );
  assert.equal((await chat(worker.token, '/inbox', {})).status, 403);
  assert.equal((await chat(host.token, '/inbox', {})).status, 403);
  assert.equal((await state(member.token)).session.host, host.user.email);

  const original = await send(host.token, 'Cover macOS and Linux');
  const conflicting = await send(member.token, 'Make it macOS only');
  const unrelated = await send(host.token, 'Check broken links');
  assert.equal((await chat(host.token, '/messages', original)).status, 201);
  const pending = await delegate(original, worker.agent.id, 70);
  assert.equal(pending.status, 200, await pending.clone().text());
  assert.equal((await state(member.token)).approvals.length, 1);
  assert.equal((await approve(host.token, original)).status, 403);
  assert.equal(
    (await decision(conflicting, { action: 'clarify', text: 'Which platforms should we cover?', hold: original.id }))
      .status,
    200,
  );
  assert.equal((await approve(member.token, original)).status, 409);
  assert.equal((await state(member.token)).messages.find(({ id }) => id === unrelated.id)?.processing, undefined);
  const inboxResponse = await chat(coordinator.token, '/inbox', {});
  assert.equal(inboxResponse.status, 200);
  const inbox = chatInboxSchema.parse(await inboxResponse.json());
  // The orchestrator takes one message at a time, and every member sees it as processing.
  assert.equal(inbox.next?.id, unrelated.id);
  assert.equal(inbox.next?.processing, true);
  assert.equal((await state(member.token)).messages.find(({ id }) => id === unrelated.id)?.processing, true);
  assert.deepEqual(
    inbox.held.map(({ id }) => id),
    [original.id],
  );
  const held = await state(member.token);
  assert.equal(held.questions[0]?.replyTo, original.id);
  assert.equal(held.messages.find(({ id }) => id === original.id)?.status, 'clarification');

  const answer = await send(member.token, 'Keep both platforms', original.id);
  const decisions = await Promise.all([delegate(answer, worker.agent.id, 70), delegate(answer, worker.agent.id, 70)]);
  assert.deepEqual(decisions.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await delegate(unrelated, secondWorker.agent.id, 40)).status, 200);
  assert.equal((await state(member.token)).messages.find(({ id }) => id === unrelated.id)?.processing, undefined);
  const racing = await Promise.all([approve(member.token, answer), approve(member.token, unrelated)]);
  assert.deepEqual(racing.map((result) => result.status).sort(), [200, 409]);
  let active = await state(member.token);
  assert.equal(active.runs.length, 1);
  assert.equal(active.questions.length, 0);
  assert.equal(active.usage.agents, 1);
  const run = active.runs[0]!;
  const winner = run.messageId === answer.id ? worker : secondWorker;
  assert.equal(run.workerId, winner.agent.id);
  const otherWorker = winner === worker ? secondWorker : worker;
  assert.equal((await request(otherWorker.token, `/tasks/${run.taskId}/claim`, {})).status, 409);
  assert.equal((await request(winner.token, `/tasks/${run.taskId}/claim`, {})).status, 200);
  assert.equal((await state(member.token)).running, 1);
  const usage = `/tasks/${run.taskId}/usage`;
  assert.equal((await chat(otherWorker.token, usage, { tokens: 20 })).status, 403);
  await sql`insert into chat_token_hours values
    (${clan.id}, date_trunc('hour', now(), 'UTC') - interval '3 hours', 7),
    (${clan.id}, date_trunc('hour', now(), 'UTC') - interval '25 hours', 99)`;
  assert.equal((await chat(winner.token, usage, { tokens: 12 })).status, 200);
  const result = { tokens: 20, result: { id: randomUUID(), text: 'Reviewed the guide.' } };
  const reports = await Promise.all([chat(winner.token, usage, result), chat(winner.token, usage, result)]);
  assert.deepEqual(
    reports.map(({ status }) => status),
    [200, 200],
  );
  const changedResult = { tokens: 25, result: { ...result.result, text: 'Different report' } };
  assert.equal((await chat(winner.token, usage, changedResult)).status, 409);
  assert.equal((await request(winner.token, `/tasks/${run.taskId}/complete`, {})).status, 200);
  active = await state(member.token);
  assert.deepEqual(active.usage, { tokens: 20, reserved: 0, agents: 0 });
  const metrics = await chat(host.token, '/metrics?window=24h');
  assert.equal(metrics.status, 200);
  const trend = chatMetricsSchema.parse(await metrics.json()).tokens;
  assert.equal(trend.length, 24);
  // The last two buckets cover a report even if the UTC hour turns during the test.
  assert.ok(trend.slice(-5, -2).includes(7));
  assert.equal(
    trend.slice(-2).reduce((sum, tokens) => sum + tokens, 0),
    20,
  );
  assert.equal(
    trend.reduce((sum, tokens) => sum + tokens, 0),
    27,
  );
  assert.equal(active.runs[0]?.status, 'done');
  assert.equal(active.messages.filter(({ id }) => id === result.result.id).length, 1);

  assert.equal(
    (await chat(member.token, '/join', { approval: 'automatic', tokenLimit: 100, agentLimit: null })).status,
    200,
  );
  const tooLarge = await send(member.token, 'Large task');
  const fits = await send(member.token, 'Small task');
  assert.deepEqual(await (await delegate(tooLarge, worker.agent.id, 81)).json(), {
    status: 'approval',
    blocker: 'This delegation would exceed your token limit',
  });
  assert.deepEqual(await (await delegate(fits, worker.agent.id, 80)).json(), { status: 'handled', blocker: null });
  const queued = await state(member.token);
  assert.deepEqual(queued.usage, { tokens: 20, reserved: 80, agents: 1 });
  const queuedTask = queued.runs.find(({ messageId }) => messageId === fits.id)!.taskId;
  const changed = await send(host.token, 'Hold the small task until we agree on the scope');
  assert.equal(
    (await decision(changed, { action: 'clarify', text: 'Which scope should we use?', hold: fits.id })).status,
    200,
  );
  assert.equal((await request(worker.token, `/tasks/${queuedTask}/claim`, {})).status, 409);
  assert.deepEqual((await state(member.token)).usage, { tokens: 20, reserved: 0, agents: 0 });
  assert.equal((await approve(member.token, tooLarge, false)).status, 200);

  // Model limits come from the worker owner's chat settings and are rechecked when the owner approves.
  // A join without allowedModels (an older client) keeps the saved models.
  const models = (allowedModels: string[] | null) =>
    chat(member.token, '/settings', { ...defaultChatSettings, allowedModels });
  assert.equal((await models(['model-a', 'model-b'])).status, 200);
  const { allowedModels: _omitted, ...olderClient } = defaultChatSettings;
  const kept = await chat(member.token, '/join', olderClient);
  assert.deepEqual((await kept.json()).allowedModels, ['model-a', 'model-b']);
  const modelTask = (msg: SendChat, workerId: string, model?: string) =>
    decision(msg, { action: 'delegate', title: msg.text, description: msg.text, workerId, estimatedTokens: 5, model });
  const first = await send(member.token, 'Use the default model');
  const disallowed = await modelTask(first, worker.agent.id, 'model-c');
  assert.equal(disallowed.status, 409);
  const error = (await disallowed.json()) as { error: { code: string; message: string } };
  assert.equal(error.error.code, 'MODEL_NOT_ALLOWED');
  assert.match(error.error.message, /model-a, model-b/);
  assert.equal((await state(member.token)).messages.find(({ id }) => id === first.id)?.status, 'queued');
  assert.equal(
    (await chat(member.token, `/messages/${first.id}/decision`, { action: 'reply', text: 'x' })).status,
    403,
  );
  assert.equal(
    (await chat(worker.token, `/messages/${first.id}/decision`, { action: 'reply', text: 'x' })).status,
    403,
  );
  assert.equal((await modelTask(first, worker.agent.id)).status, 200);
  const second = await send(member.token, 'Use model b');
  assert.equal((await modelTask(second, secondWorker.agent.id, 'model-b')).status, 200);
  const ours = (approvals: ChatState['approvals'], ids: string[]) =>
    approvals.filter(({ messageId }) => ids.includes(messageId)).map(({ messageId, model }) => [messageId, model]);
  assert.deepEqual(ours((await state(member.token)).approvals, [first.id, second.id]), [
    [first.id, 'model-a'],
    [second.id, 'model-b'],
  ]);
  assert.equal((await models(['model-b'])).status, 200);
  const revoked = await approve(member.token, first);
  assert.equal(revoked.status, 409);
  assert.match(await revoked.text(), /not in your allowed models \(model-b\)/);
  assert.equal((await approve(member.token, second)).status, 200);
  assert.equal((await state(member.token)).runs.find(({ messageId }) => messageId === second.id)?.model, 'model-b');
  assert.equal((await approve(member.token, first, false)).status, 200);

  assert.equal((await models(null)).status, 200);
  const anyModel = await send(member.token, 'Any model works');
  assert.equal((await modelTask(anyModel, worker.agent.id, 'vendor/new-model')).status, 200);
  const defaultModel = await send(member.token, 'No model chosen');
  assert.equal((await modelTask(defaultModel, worker.agent.id)).status, 200);
  assert.deepEqual(ours((await state(member.token)).approvals, [anyModel.id, defaultModel.id]), [
    [anyModel.id, 'vendor/new-model'],
    [defaultModel.id, null],
  ]);
});

test('PostgreSQL: attachments reach clan members and the delegated worker only', { skip }, async (t) => {
  const { connection, user } = await database(t);
  const [host, outsider] = await Promise.all([user(), user()]);
  const clan = await connection.store.createClan(host.user.id, 'Attachments');
  const coordinator = await connection.store.registerAgent(host.user, clan.id, 'Coordinator', 'orchestrator');
  const worker = await connection.store.registerAgent(host.user, clan.id, 'Worker');
  const app = createApp(connection.store, connection.db);
  const chat = (token: string, suffix: string, body?: object) =>
    app.request(`/v1/clans/${clan.id}/chat${suffix}`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const state = async () => chatStateSchema.parse(await (await chat(host.token, '/state')).json());
  const png = { name: 'screen.png', type: 'image/png', data: Buffer.from('png bytes').toString('base64') };
  const pdf = { name: 'spec.pdf', type: 'application/pdf', data: Buffer.from('pdf bytes').toString('base64') };
  assert.equal((await chat(host.token, '/join', defaultChatSettings)).status, 200);

  const tooMany = { id: randomUUID(), text: 'Five files', attachments: [png, png, png, png, png] };
  assert.equal((await chat(host.token, '/messages', tooMany)).status, 400);
  const wrongType = { id: randomUUID(), text: 'A zip', attachments: [{ ...png, type: 'application/zip' }] };
  assert.equal((await chat(host.token, '/messages', wrongType)).status, 400);
  // The body limit leaves room for four files of the maximum size, but not much more.
  const huge = 'A'.repeat(32 * 1024 * 1024);
  assert.equal((await chat(host.token, '/messages', { id: randomUUID(), text: huge })).status, 413);

  const question = { id: randomUUID(), text: 'Build this screen [Image #1]', attachments: [png] };
  assert.equal((await chat(host.token, '/messages', question)).status, 201);
  // A retry keeps the first copy instead of storing the files twice.
  assert.equal((await chat(host.token, '/messages', question)).status, 201);
  const [image] = (await state()).messages.find(({ id }) => id === question.id)!.attachments!;
  assert.deepEqual({ ...image, id: undefined }, { id: undefined, name: 'screen.png', type: 'image/png', size: 9 });
  const count = await connection.db.execute(
    sql`select count(*)::int as count from chat_attachments where message_id = ${question.id}`,
  );
  assert.equal(count[0]!.count, 1);

  const download = async (token: string, id: string) => chat(token, `/attachments/${id}`);
  assert.equal((await download(outsider.token, image!.id)).status, 404);
  assert.equal((await download(host.token, randomUUID())).status, 404);
  const file = chatAttachmentFileSchema.parse(await (await download(coordinator.token, image!.id)).json());
  assert.equal(Buffer.from(file.data, 'base64').toString(), 'png bytes');

  // A delegated answer to a clarification carries both messages' files to the worker.
  const inbox = chatInboxSchema.parse(await (await chat(coordinator.token, '/inbox', {})).json());
  assert.equal(inbox.next?.attachments?.[0]?.id, image!.id);
  const clarify = { action: 'clarify', text: 'Which framework?', hold: question.id, pickId: inbox.pickId };
  assert.equal((await chat(coordinator.token, `/messages/${question.id}/decision`, clarify)).status, 200);
  const answer = { id: randomUUID(), text: 'React, per [PDF #1: spec.pdf]', replyTo: question.id, attachments: [pdf] };
  assert.equal((await chat(host.token, '/messages', answer)).status, 201);
  const next = chatInboxSchema.parse(await (await chat(coordinator.token, '/inbox', {})).json());
  const delegate = {
    action: 'delegate',
    title: 'Build the screen',
    description: 'Build the screen in React',
    workerId: worker.agent.id,
    estimatedTokens: 100,
    pickId: next.pickId,
  };
  assert.equal((await chat(coordinator.token, `/messages/${answer.id}/decision`, delegate)).status, 200);
  assert.equal((await chat(host.token, `/messages/${answer.id}/approval`, { approve: true })).status, 200);
  const [run] = (await state()).runs;
  assert.deepEqual(
    run?.attachments?.map(({ name }) => name),
    ['screen.png', 'spec.pdf'],
  );
  const worked = chatAttachmentFileSchema.parse(await (await download(worker.token, run!.attachments![1]!.id)).json());
  assert.equal(Buffer.from(worked.data, 'base64').toString(), 'pdf bytes');
});
