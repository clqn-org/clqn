import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { type ChatState, chatInboxSchema, chatStateSchema, defaultChatSettings, type SendChat } from '@clqn/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createApp } from '../src/app.js';
import { createStore } from '../src/db/store.js';

test('PostgreSQL: shared chat, held work, owner approvals, and competing delegations', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 2 });
  const connection = createStore(process.env.TEST_DATABASE_URL!);
  const users: string[] = [];
  const clans: string[] = [];
  t.after(async () => {
    try {
      if (clans.length) {
        await sql`delete from chats where clan_id in ${sql(clans)}`;
        await sql`delete from tasks where clan_id in ${sql(clans)}`;
        await sql`delete from events where clan_id in ${sql(clans)}`;
        await sql`delete from credentials where user_id in ${sql(users)}`;
        await sql`delete from agents where clan_id in ${sql(clans)}`;
        await sql`delete from memberships where clan_id in ${sql(clans)}`;
        await sql`delete from clans where id in ${sql(clans)}`;
      }
      if (users.length) await sql`delete from users where id in ${sql(users)}`;
    } finally {
      await connection.close();
      await sql.end();
    }
  });
  await migrate(drizzle(sql), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  async function user(name: string) {
    const person = await connection.provisionUser(`${name}-${randomUUID()}@example.com`);
    users.push(person.user.id);
    return person;
  }
  const [host, member, outsider] = await Promise.all([user('host'), user('member'), user('outsider')]);
  const clan = await connection.store.createClan(host.user.id, 'Docs refresh');
  clans.push(clan.id);
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
  assert.equal((await chat(member.token, '/join', defaultChatSettings)).status, 404);
  assert.equal((await chat(host.token, '/join', defaultChatSettings)).status, 200);
  assert.equal((await chat(member.token, '/state')).status, 403);
  assert.equal(
    (await chat(member.token, '/join', { ...defaultChatSettings, agentLimit: 1, tokenLimit: 100 })).status,
    200,
  );
  assert.equal((await chat(worker.token, '/inbox')).status, 403);
  assert.equal((await chat(host.token, '/inbox')).status, 403);
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
  const inboxResponse = await chat(coordinator.token, '/inbox');
  assert.equal(inboxResponse.status, 200);
  const inbox = chatInboxSchema.parse(await inboxResponse.json());
  assert.deepEqual(
    inbox.queued.map(({ id }) => id),
    [unrelated.id],
  );
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
  const racing = await Promise.all([approve(member.token, answer), approve(member.token, unrelated)]);
  assert.deepEqual(racing.map((result) => result.status).sort(), [200, 409]);
  let active = await state(member.token);
  assert.equal(active.runs.length, 1);
  assert.equal(active.questions.length, 0);
  assert.equal(active.usage.agents, 1);
  const run = active.runs[0]!;
  const winner = run.messageId === answer.id ? worker : secondWorker;
  const otherWorker = winner === worker ? secondWorker : worker;
  assert.equal((await request(otherWorker.token, `/tasks/${run.taskId}/claim`, {})).status, 409);
  assert.equal((await request(winner.token, `/tasks/${run.taskId}/claim`, {})).status, 200);
  assert.equal((await state(member.token)).running, 1);
  const usage = `/tasks/${run.taskId}/usage`;
  assert.equal((await chat(otherWorker.token, usage, { tokens: 20 })).status, 403);
  const result = { tokens: 20, result: { id: randomUUID(), text: 'Reviewed the guide.' } };
  assert.equal((await chat(winner.token, usage, result)).status, 200);
  assert.equal((await chat(winner.token, usage, result)).status, 200);
  assert.equal((await request(winner.token, `/tasks/${run.taskId}/complete`, {})).status, 200);
  active = await state(member.token);
  assert.deepEqual(active.usage, { tokens: 20, reserved: 0, agents: 0 });
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
});
