import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  agentRegistrationSchema,
  agentsSchema,
  chatStateSchema,
  defaultChatSettings,
  type WorkerModel,
} from '@clqn/shared';
import { createApp } from '../src/app.js';
import { hashToken } from '../src/db/store.js';
import { database, skip } from './postgres.js';

test('PostgreSQL: worker catalogs are scoped to an active credential and clear when it changes', {
  skip,
}, async (t) => {
  const { connection, sql, user } = await database(t);
  const [leader, member, outsider] = await Promise.all([user(), user(), user()]);
  const clan = await connection.store.createClan(leader.user.id, 'Model catalogs');
  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${member.user.id})`;
  const host = await connection.store.registerAgent(leader.user, clan.id, 'Orchestrator', 'orchestrator');
  const worker = await connection.store.registerAgent(member.user, clan.id, 'Worker');
  const manual = await connection.store.registerAgent(member.user, clan.id, 'Manual worker');
  const app = createApp(connection.store, connection.db);
  const agents = `/v1/clans/${clan.id}/agents`;
  const request = (token: string, path: string, body?: object) =>
    app.request(path, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
  const list = async () => {
    const response = await request(leader.token, agents);
    assert.equal(response.status, 200);
    return agentsSchema.parse(await response.json()).agents;
  };
  const readWorker = async () => (await list()).find(({ id }) => id === worker.agent.id);
  const models = [{ id: 'model-a', label: 'Model A', description: 'Reports its available model.' }];
  const report = (token: string, catalog: WorkerModel[] | null = models) =>
    request(token, '/v1/agent/models', { models: catalog });
  assert.equal((await readWorker())?.availableModels, null);
  assert.equal((await report(member.token)).status, 403);
  assert.equal((await report(host.token)).status, 403);
  assert.equal((await request(outsider.token, agents)).status, 404);

  const saved = await report(worker.token);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { models });
  assert.deepEqual((await readWorker())?.availableModels, models);
  assert.equal((await list()).find(({ id }) => id === manual.agent.id)?.availableModels, null);
  assert.deepEqual(await (await request(worker.token, '/v1/agent')).json(), worker.agent);

  // A report racing rotation either finishes before reset or is denied by the new credential state.
  const hashed = hashToken(worker.token);
  const staleActor = await connection.store.authenticate(hashed);
  assert.ok(staleActor);
  assert.equal(staleActor.agentId, worker.agent.id);
  const [racing, replacement] = await Promise.all([
    report(worker.token, [{ id: 'model-b' }]),
    request(member.token, `${agents}/${worker.agent.id}/token`, {}),
  ]);
  assert.ok([200, 401, 403].includes(racing.status));
  assert.equal(replacement.status, 200);
  const rotated = agentRegistrationSchema.parse(await replacement.json());
  assert.equal((await readWorker())?.availableModels, null);
  await assert.rejects(connection.store.reportWorkerModels(staleActor, hashed, models), { status: 403 });
  assert.equal((await report(worker.token)).status, 401);
  assert.equal((await report(rotated.token)).status, 200);
  assert.deepEqual(await (await request(rotated.token, '/v1/logout', {})).json(), { revoked: true });
  assert.equal((await readWorker())?.availableModels, null);
  assert.equal((await readWorker())?.active, false);

  const issued = await request(member.token, `${agents}/${worker.agent.id}/token`, {});
  const revived = agentRegistrationSchema.parse(await issued.json());
  assert.equal((await report(revived.token)).status, 200);
  assert.equal((await request(leader.token, `${agents}/${worker.agent.id}/revoke`, {})).status, 200);
  assert.equal((await readWorker())?.availableModels, null);
});

test('PostgreSQL: chat selects from allowed advertised models and rechecks the exact model at approval', {
  skip,
}, async (t) => {
  const { connection, sql, user } = await database(t);
  const [leader, member] = await Promise.all([user(), user()]);
  const clan = await connection.store.createClan(leader.user.id, 'Model selection');
  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${member.user.id})`;
  const host = await connection.store.registerAgent(leader.user, clan.id, 'Orchestrator', 'orchestrator');
  const worker = await connection.store.registerAgent(member.user, clan.id, 'Worker');
  const app = createApp(connection.store, connection.db);
  const request = (token: string, path: string, body?: object) =>
    app.request(`/v1${path}`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
  const chat = (token: string, path: string, body?: object) => request(token, `/clans/${clan.id}/chat${path}`, body);
  const report = async (models: WorkerModel[] | null) => {
    const response = await request(worker.token, '/agent/models', { models });
    assert.equal(response.status, 200);
  };
  const state = async () => chatStateSchema.parse(await (await chat(member.token, '/state')).json());
  const setAllowed = async (allowedModels: string[] | null) => {
    assert.equal((await chat(member.token, '/settings', { ...defaultChatSettings, allowedModels })).status, 200);
  };
  async function send(text: string) {
    const id = randomUUID();
    assert.equal((await chat(member.token, '/messages', { id, text })).status, 201);
    return id;
  }
  const delegate = (id: string, model?: string) =>
    chat(host.token, `/messages/${id}/decision`, {
      action: 'delegate',
      title: 'Build the feature',
      description: 'Build the feature.',
      workerId: worker.agent.id,
      estimatedTokens: 5,
      model,
    });
  const approve = (id: string, approve = true) => chat(member.token, `/messages/${id}/approval`, { approve });
  const approval = async (id: string) => (await state()).approvals.find(({ messageId }) => messageId === id);
  async function reject(pending: Promise<Response> | Response, code: string) {
    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, code);
  }

  assert.equal((await chat(leader.token, '/join', defaultChatSettings)).status, 200);
  await setAllowed(['model-a', 'model-b', 'model-c']);
  assert.equal((await state()).workerModelDiscovery, true);
  await report([{ id: 'model-c' }, { id: 'model-b' }, { id: 'model-owner-disabled' }]);
  const id = await send('Build it with an available model.');
  await reject(delegate(id, 'model-a'), 'MODEL_NOT_AVAILABLE');
  await reject(delegate(id, 'model-owner-disabled'), 'MODEL_NOT_ALLOWED');
  assert.equal((await delegate(id)).status, 200);
  assert.equal((await approval(id))?.model, 'model-b');

  await report([{ id: 'model-c' }]);
  await reject(approve(id), 'MODEL_NOT_AVAILABLE');
  assert.equal((await approval(id))?.model, 'model-b');
  assert.equal((await state()).runs.length, 0);
  assert.equal((await approve(id, false)).status, 200);

  await setAllowed(['model-a']);
  const noMatch = await send('Try using the default.');
  await reject(delegate(noMatch), 'MODEL_NOT_AVAILABLE');
  await report(null);
  assert.equal((await delegate(noMatch)).status, 200);
  assert.equal((await approval(noMatch))?.model, 'model-a');
  assert.equal((await approve(noMatch)).status, 200);
  assert.equal((await state()).runs[0]?.model, 'model-a');

  await setAllowed(null);
  await report([{ id: 'model-c' }]);
  const unrestricted = await send('Use the runtime default model.');
  await reject(delegate(unrestricted, 'model-a'), 'MODEL_NOT_AVAILABLE');
  assert.equal((await delegate(unrestricted)).status, 200);
  assert.equal((await approval(unrestricted))?.model, null);
});
