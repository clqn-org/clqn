import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import type { WorkspaceStore } from '../src/store.js';

const alice = { id: '65fd2b48-b47f-4862-a85d-af491cdb8a3c', email: 'alice@example.com' };
const clanId = 'e6faf7c5-0b04-45de-8eba-c1fda2a17a89';
const agentId = 'f1796d17-12d5-4620-ad88-e285713350a1';
const token = `clqn_${'a'.repeat(43)}`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const createdAt = new Date().toISOString();
const clan = (id: string) => ({ id, name: 'Clan', createdBy: alice.id, createdAt });
// Tests stub only the store methods each route uses.
const stub = (methods: Partial<WorkspaceStore>) => methods as WorkspaceStore;

test('agent credentials cannot administer clans or escape their registered clan', async () => {
  const actor = { ...alice, clanId, agentId };
  const app = createApp(
    stub({
      authenticate: async () => actor,
      listClans: async () => [clan(clanId), clan(alice.id)],
      members: async () => [{ userId: alice.id, email: alice.email, role: 'leader', createdAt }],
    }),
  );
  for (const path of [
    '/v1/clans',
    '/v1/invitations/join',
    `/v1/clans/${clanId}/agents`,
    `/v1/clans/${clanId}/invitations`,
  ]) {
    assert.equal((await app.request(path, { method: 'POST', headers, body: '{}' })).status, 403);
  }
  for (const path of ['members', 'agents', 'context', 'tasks', 'events', 'status']) {
    assert.equal((await app.request(`/v1/clans/${alice.id}/${path}`, { headers })).status, 404);
  }
  const list = await app.request('/v1/clans', { headers });
  assert.deepEqual((await list.json()).clans, [clan(clanId)]);
  assert.equal((await app.request(`/v1/clans/${clanId}/members`, { headers })).status, 200);
});

test('agent registration uses the authenticated owner, validates the name, and exposes registration status', async () => {
  const agent = { id: agentId, clanId, ownerId: alice.id, name: 'Codex', role: 'worker' as const, createdAt };
  const app = createApp(
    stub({
      authenticate: async () => alice,
      registerAgent: async (actor, receivedClan, name) => {
        assert.deepEqual(actor, alice);
        assert.equal(receivedClan, clanId);
        assert.equal(name, 'Codex');
        return { agent, token };
      },
      agentStatus: async () => undefined,
      listAgents: async () => [agent],
    }),
  );
  const post = (body: object) =>
    app.request(`/v1/clans/${clanId}/agents`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post({ name: ' Codex ' })).status, 201);
  for (const body of [{}, { name: ' ' }, { name: 'x'.repeat(101) }, { name: 'Codex', ownerId: alice.id }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await app.request('/v1/agent', { headers })).status, 404);
  const list = await app.request(`/v1/clans/${clanId}/agents`, { headers });
  assert.deepEqual(await list.json(), { agents: [agent] });
});
