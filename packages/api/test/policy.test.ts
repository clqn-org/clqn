import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultPolicy, updatePolicySchema } from '@clqn/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createApp } from '../src/app.js';
import { createStore } from '../src/db/store.js';

test('policies reject malformed budgets, model lists, control levels and ownership overrides', () => {
  for (const settings of [
    {},
    { tokenLimit: -1 },
    { tokenLimit: 1.5 },
    { tokenLimit: Number.MAX_SAFE_INTEGER + 1 },
    { allowedModels: [] },
    { allowedModels: [''] },
    { allowedModels: ['provider/model', 'provider/model'] },
    { allowedModels: ['two models'] },
    { allowedModels: ['nul\0'] },
    { control: 'full' },
    { control: 'automatic', userId: randomUUID() },
    { tokenLimit: 100, enforcement: 'enabled' },
  ])
    assert.equal(
      updatePolicySchema.safeParse({ expectedRevision: 0, ...settings }).success,
      false,
      JSON.stringify(settings),
    );
  for (const settings of [
    { tokenLimit: 0 },
    { tokenLimit: null },
    { allowedModels: null },
    { allowedModels: ['provider/model-a', 'provider/model-b'] },
    { control: 'approve' },
  ]) {
    assert.equal(updatePolicySchema.safeParse({ expectedRevision: 0, ...settings }).success, true);
  }
  assert.equal(updatePolicySchema.safeParse({ tokenLimit: 10 }).success, false);
});

test('PostgreSQL: only the member changes their policy; concurrent writes cannot overwrite it', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 5 });
  const connection = createStore(process.env.TEST_DATABASE_URL!);
  const userIds: string[] = [];
  const clanIds: string[] = [];
  t.after(async () => {
    try {
      if (clanIds.length) {
        await sql`delete from events where clan_id in ${sql(clanIds)}`;
        await sql`delete from credentials where user_id in ${sql(userIds)}`;
        await sql`delete from agents where clan_id in ${sql(clanIds)}`;
        await sql`delete from memberships where clan_id in ${sql(clanIds)}`;
        await sql`delete from clans where id in ${sql(clanIds)}`;
      }
      if (userIds.length) await sql`delete from users where id in ${sql(userIds)}`;
    } finally {
      await connection.close();
      await sql.end();
    }
  });
  await migrate(drizzle(sql), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const alice = await connection.provisionUser(`${randomUUID()}@example.com`);
  const bob = await connection.provisionUser(`${randomUUID()}@example.com`);
  userIds.push(alice.user.id, bob.user.id);
  const clan = await connection.store.createClan(alice.user.id, 'Policy test');
  const other = await connection.store.createClan(bob.user.id, 'Separate policy');
  clanIds.push(clan.id, other.id);
  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${bob.user.id})`;
  const agent = await connection.store.registerAgent(bob.user, clan.id, 'Worker');
  const app = createApp(connection.store, connection.db);
  const call = (token: string, body?: object, clanId = clan.id) =>
    app.request(`/v1/clans/${clanId}/policy`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const initial = { ...defaultPolicy, clanId: clan.id, userId: bob.user.id, revision: 0, enforcement: 'unavailable' };
  assert.deepEqual(await (await call(bob.token)).json(), initial);
  assert.equal((await call(alice.token, undefined, other.id)).status, 404);
  assert.equal((await call(agent.token, undefined, other.id)).status, 404);
  assert.equal((await call(bob.token, undefined, 'invalid')).status, 404);
  assert.equal((await call(agent.token, { expectedRevision: 0, control: 'automatic' })).status, 403);
  // Neither agents nor a leader can forge a target user or change who owns a policy.
  assert.equal(
    (await call(alice.token, { expectedRevision: 0, control: 'automatic', userId: bob.user.id })).status,
    400,
  );
  const changed = await call(bob.token, {
    expectedRevision: 0,
    tokenLimit: 10000,
    allowedModels: ['provider/model-a'],
    control: 'approve',
  });
  assert.equal(changed.status, 200);
  const saved = { ...initial, tokenLimit: 10000, allowedModels: ['provider/model-a'], control: 'approve', revision: 1 };
  assert.deepEqual(await changed.json(), saved);
  assert.deepEqual(await (await call(agent.token)).json(), saved);
  assert.deepEqual(await (await call(alice.token)).json(), { ...initial, userId: alice.user.id });
  assert.deepEqual(await (await call(bob.token, undefined, other.id)).json(), {
    ...initial,
    clanId: other.id,
  });
  const writes = await Promise.all([
    call(bob.token, { expectedRevision: 1, control: 'manual' }),
    call(bob.token, { expectedRevision: 1, tokenLimit: 20000 }),
  ]);
  assert.deepEqual(writes.map((r) => r.status).sort(), [200, 409]);
  const winner = await writes.find((r) => r.status === 200)?.json();
  assert.equal(winner.revision, 2);
  assert.deepEqual(await (await call(bob.token)).json(), winner);
  assert.equal((await call(bob.token, { expectedRevision: 1, allowedModels: null })).status, 409);
  // Revocation does not accidentally remove the budget or model restriction.
  const revoked = await (await call(bob.token, { expectedRevision: 2, control: 'manual' })).json();
  assert.equal(revoked.control, 'manual');
  assert.deepEqual(revoked.allowedModels, ['provider/model-a']);
  assert.equal(revoked.tokenLimit, winner.tokenLimit);
  const [audit] =
    await sql`select count(*)::integer as n from events where clan_id = ${clan.id} and type = 'policy.updated'`;
  assert.equal(audit?.n, 3);
});
