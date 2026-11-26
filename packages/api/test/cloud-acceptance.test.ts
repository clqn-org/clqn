import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chatStateSchema, defaultChatSettings } from '@clqn/shared';
import { createApp } from '../src/app.js';
import { startCloudOrchestrator } from '../src/cloud-runner.js';
import { database, skip } from './postgres.js';

test('a member can start and run approved work with the leader offline', { skip, timeout: 10_000 }, async (t) => {
  const { sql, connection, user } = await database(t);
  const [leader, member] = await Promise.all([user(), user()]);
  const clan = await connection.store.createClan(leader.user.id, 'Cloud acceptance');
  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${member.user.id})`;
  const worker = await connection.store.registerAgent(member.user, clan.id, 'Online worker');
  const app = createApp(connection.store, connection.db, { cloudOrchestrator: true });
  const request = (path: string, body?: object, token = member.token) =>
    app.request(`/v1/clans/${clan.id}/${path}`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });

  assert.equal((await request('chat/join', defaultChatSettings)).status, 200);
  assert.equal((await request('chat/workers/presence', { agentIds: [worker.agent.id] })).status, 200);
  const messageId = randomUUID();
  assert.equal((await request('chat/messages', { id: messageId, text: 'Add a project README.' })).status, 201);

  const model = t.mock.method(globalThis, 'fetch', async (_url: string, _init: RequestInit) =>
    Response.json({
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                decision: {
                  action: 'delegate',
                  title: 'Add a README',
                  description: 'Add a README explaining the project and how to run it.',
                  workerId: worker.agent.id,
                  estimatedTokens: 1500,
                  model: null,
                },
              }),
            },
          ],
        },
      ],
    }),
  );
  const runner = startCloudOrchestrator(connection.db, {
    apiKey: 'test-key',
    model: 'gpt-5.4-mini',
    maxCallsPerHour: 10_000,
  });
  const state = async () => chatStateSchema.parse(await (await request('chat/state')).json());
  try {
    const deadline = Date.now() + 5_000;
    let pending = await state();
    while (!pending.approvals.length && Date.now() < deadline) {
      await delay(25);
      pending = await state();
    }
    assert.equal(pending.session.cloudOrchestrator, true);
    assert.equal(pending.approvals[0]?.messageId, messageId);
    assert.equal(pending.runs.length, 0);
    assert.equal(model.mock.callCount(), 1);
    assert.equal((await request(`chat/messages/${messageId}/approval`, { approve: true })).status, 200);
    const [run] = (await state()).runs;
    assert.equal(run?.workerId, worker.agent.id);
    assert.equal((await request(`tasks/${run?.taskId}/claim`, {}, worker.token)).status, 200);
  } finally {
    await runner.stop();
  }
});
