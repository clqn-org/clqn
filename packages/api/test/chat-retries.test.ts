import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { type ChatState, chatInboxSchema, chatStateSchema, defaultChatSettings, type SendChat } from '@clqn/shared';
import { createApp } from '../src/app.js';
import { database, skip } from './postgres.js';

test('PostgreSQL: stopped chat tasks go back to the orchestrator, and follow-ups wait on earlier tasks', {
  skip,
}, async (t) => {
  const { connection, user: provision } = await database(t);
  const host = await provision(`host-${randomUUID()}@example.com`);
  const clan = await connection.store.createClan(host.user.id, 'Retries');
  const orchestrator = await connection.store.registerAgent(host.user, clan.id, 'Orchestrator', 'orchestrator');
  const worker = await connection.store.registerAgent(host.user, clan.id, 'Claude Code');
  const app = createApp(connection.store, connection.db);
  const request = (token: string, suffix: string, body?: object) =>
    app.request(`/v1/clans/${clan.id}${suffix}`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const ok = async (response: Response, status = 200) => {
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  };
  const state = async (): Promise<ChatState> =>
    chatStateSchema.parse(await ok(await request(host.token, '/chat/state')));
  const inbox = async () => chatInboxSchema.parse(await ok(await request(orchestrator.token, '/chat/inbox')));
  const delegate = (id: string, title: string, after?: string) =>
    request(orchestrator.token, `/chat/messages/${id}/decision`, {
      action: 'delegate',
      title,
      description: `Do ${title}`,
      workerId: worker.agent.id,
      estimatedTokens: 10,
      ...(after ? { after } : {}),
    });
  const runFor = async (messageId: string) => (await state()).runs.find((run) => run.messageId === messageId)!;
  const task = (taskId: string, action: string, body: object = {}) =>
    request(worker.token, `/tasks/${taskId}/${action}`, body);

  await ok(await request(host.token, '/chat/join', { ...defaultChatSettings, approval: 'automatic' }));
  const ask: SendChat = { id: randomUUID(), text: 'Add a health check' };
  await ok(await request(host.token, '/chat/messages', ask), 201);
  assert.equal((await ok(await delegate(ask.id, 'Health check'))).status, 'handled');
  let run = await runFor(ask.id);

  // A reason must be short plain text; claim and complete still take an empty body.
  await ok(await task(run.taskId, 'claim'));
  assert.equal((await task(run.taskId, 'release', { reason: 'x'.repeat(501) })).status, 400);
  assert.equal((await task(run.taskId, 'complete', { reason: 'done' })).status, 400);

  // Each release posts a queued note for the orchestrator; the third attempt gives up and only tells the clan.
  let previous = ask.id;
  for (const attempt of [1, 2, 3]) {
    if (attempt > 1) await ok(await task(run.taskId, 'claim'));
    await ok(await task(run.taskId, 'release', { reason: 'the agent failed: rate limited' }));
    const { queued, runs, messages } = await inbox();
    const note = messages.find((message) => message.replyTo === previous && message.role === 'worker')!;
    assert.equal(note.author, 'Claude Code');
    assert.match(note.text, /“Health check”: the agent failed: rate limited/);
    assert.equal(runs?.find((entry) => entry.taskId === run.taskId)?.status, 'released');
    assert.equal(runs?.find((entry) => entry.taskId === run.taskId)?.description, 'Do Health check');
    if (attempt === 3) {
      assert.equal(note.status, 'handled');
      assert.match(note.text, /Not retrying after 3 attempts/);
      assert.equal(queued.length, 0);
    } else {
      assert.deepEqual(
        queued.map(({ id }) => id),
        [note.id],
      );
      await ok(await delegate(note.id, 'Health check'));
      run = await runFor(note.id);
      previous = note.id;
    }
  }

  // A release without a reason still goes back to the queue.
  const docs: SendChat = { id: randomUUID(), text: 'Document the health check' };
  await ok(await request(host.token, '/chat/messages', docs), 201);
  await ok(await delegate(docs.id, 'Docs'));
  const docsRun = await runFor(docs.id);
  await ok(await task(docsRun.taskId, 'claim'));
  await ok(await task(docsRun.taskId, 'release'));
  const [docsNote] = (await inbox()).queued;
  assert.match(docsNote!.text, /“Docs”: it was handed back/);
  await ok(
    await request(orchestrator.token, `/chat/messages/${docsNote!.id}/decision`, { action: 'reply', text: 'Ok' }),
  );

  // A follow-up may queue on the same worker behind the task it builds on, and shows how that task is going.
  const base: SendChat = { id: randomUUID(), text: 'Add a status page' };
  const followUp: SendChat = { id: randomUUID(), text: 'Test the status page' };
  const unrelated: SendChat = { id: randomUUID(), text: 'Rename the CLI' };
  for (const message of [base, followUp, unrelated])
    await ok(await request(host.token, '/chat/messages', message), 201);
  assert.equal((await delegate(followUp.id, 'Tests', randomUUID())).status, 409);
  await ok(await delegate(base.id, 'Status page'));
  const baseRun = await runFor(base.id);
  assert.equal((await ok(await delegate(followUp.id, 'Tests', baseRun.taskId))).status, 'handled');
  assert.deepEqual((await runFor(followUp.id)).after, { taskId: baseRun.taskId, status: 'queued' });
  // Unrelated work still waits for the worker to be free.
  assert.equal((await ok(await delegate(unrelated.id, 'Rename'))).status, 'approval');
  await ok(await task(baseRun.taskId, 'claim'));
  assert.equal((await runFor(followUp.id)).after?.status, 'running');
  await ok(await task(baseRun.taskId, 'complete'));
  assert.deepEqual((await runFor(followUp.id)).after, { taskId: baseRun.taskId, status: 'done' });
});
