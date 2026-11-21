import assert from 'node:assert/strict';
import test from 'node:test';
import { errorSchema, healthSchema } from '@clqn/shared';
import { createApp } from '../dist/app.js';

test('health endpoint satisfies the shared contract without a database', async () => {
  const response = await createApp().request('/health');
  assert.equal(response.status, 200);
  assert.equal(healthSchema.parse(await response.json()).status, 'ok');
});

test('workspace endpoints require credentials', async () => {
  const response = await createApp().request('/v1/clans');
  assert.equal(response.status, 401);
  assert.equal(errorSchema.parse(await response.json()).error.code, 'UNAUTHORIZED');
});

const token = `clqn_${'a'.repeat(43)}`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const alice = { id: '65fd2b48-b47f-4862-a85d-af491cdb8a3c', email: 'alice@example.com' };

test('protected endpoints fail closed when no database is configured', async () => {
  const response = await createApp().request('/v1/me', { headers });
  assert.equal(response.status, 503);
});

test('missing, malformed, and unknown credentials never reach workspace operations', async () => {
  let lookups = 0;
  const app = createApp({
    authenticate: async () => {
      lookups++;
      return undefined;
    },
    listClans: async () => {
      assert.fail('Unauthenticated query');
    },
  });
  for (const authorization of ['', 'Bearer raw-password', `Basic ${token}`, `Bearer ${token}`]) {
    const response = await app.request('/v1/clans', { headers: { authorization } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(lookups, 1);
});

test('authentication hashes credentials and clan creation uses verified actor', async () => {
  const { hashToken } = await import('../dist/store.js');
  const app = createApp({
    authenticate: async (hash) => {
      assert.equal(hash, hashToken(token));
      return alice;
    },
    createClan: async (id, name) => {
      assert.equal(id, alice.id);
      assert.equal(name, 'Project');
      return { id: alice.id, name, createdBy: id, createdAt: new Date().toISOString() };
    },
  });
  const me = await app.request('/v1/me', { headers });
  assert.deepEqual(await me.json(), alice);
  const result = await app.request('/v1/clans', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: ' Project ' }),
  });
  assert.equal(result.status, 201);
  assert.equal((await result.json()).createdBy, alice.id);
  for (const body of [
    'no JSON',
    '{}',
    '{"name":" "}',
    JSON.stringify({ name: 'x'.repeat(101) }),
    JSON.stringify({ name: '\0' }),
    JSON.stringify({ name: 'Project', createdBy: 'attacker' }),
  ]) {
    const response = await app.request('/v1/clans', { method: 'POST', headers, body });
    assert.equal(response.status, 400);
  }
  const large = await app.request('/v1/clans', { method: 'POST', headers, body: 'x'.repeat(5000) });
  assert.equal(large.status, 413);
});

test('inaccessible, nonexistent, and invalid clan IDs reveal the same response', async () => {
  const app = createApp({ authenticate: async () => alice, members: async () => undefined });
  for (const id of [alice.id, 'bad-id']) {
    const response = await app.request(`/v1/clans/${id}/members`, { headers });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: { code: 'NOT_FOUND', message: 'Clan not found' } });
  }
});

test('invitation routes validate bodies, forward verified identity, and hide inaccessible resources', async () => {
  const code = `clqn_inv_${'b'.repeat(43)}`;
  const app = createApp({
    authenticate: async () => alice,
    createInvitation: async (userId, clanId, email) => {
      assert.equal(userId, alice.id);
      assert.equal(clanId, alice.id);
      assert.equal(email, 'bob@example.com');
      return undefined;
    },
    joinInvitation: async (user, received) => {
      assert.deepEqual(user, alice);
      assert.equal(received, code);
      return undefined;
    },
  });
  const post = (path, body) => app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post(`/v1/clans/${alice.id}/invitations`, { email: ' Bob@Example.com ' })).status, 404);
  assert.equal((await post('/v1/clans/bad/invitations', { email: 'bob@example.com' })).status, 404);
  for (const body of [{}, { email: 'bad' }, { email: 'bob@example.com', createdBy: alice.id }]) {
    assert.equal((await post(`/v1/clans/${alice.id}/invitations`, body)).status, 400);
  }
  assert.equal((await post('/v1/invitations/join', { code })).status, 404);
  assert.equal((await post('/v1/invitations/join', { code: 'bad' })).status, 400);
  assert.equal(
    (await app.request('/v1/invitations/join', { method: 'POST', headers, body: 'x'.repeat(5000) })).status,
    413,
  );
});
