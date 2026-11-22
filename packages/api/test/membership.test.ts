import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';

test('PostgreSQL: leaders remove members, members leave, and agent tokens never outlive membership', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const url = process.env.TEST_DATABASE_URL!;
  const sql = postgres(url, { max: 2 });
  const connection = createStore(url);
  const userIds: string[] = [];
  t.after(async () => {
    try {
      if (userIds.length) {
        await sql`delete from events where actor_id in ${sql(userIds)}`;
        await sql`delete from invitations where created_by in ${sql(userIds)}`;
        await sql`delete from credentials where user_id in ${sql(userIds)}`;
        await sql`delete from agents where owner_id in ${sql(userIds)}`;
        await sql`delete from memberships where user_id in ${sql(userIds)}`;
        await sql`delete from clans where created_by in ${sql(userIds)}`;
        await sql`delete from users where id in ${sql(userIds)}`;
      }
    } finally {
      await connection.close();
      await sql.end();
    }
  });
  await migrate(drizzle(sql), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const alice = await connection.provisionUser(`${randomUUID()}@example.com`);
  const bob = await connection.provisionUser(`${randomUUID()}@example.com`);
  const carol = await connection.provisionUser(`${randomUUID()}@example.com`);
  userIds.push(alice.user.id, bob.user.id, carol.user.id);
  const app = createApp(connection.store, connection.db);
  const post = (token: string, path: string, body: object = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const me = (token: string) => app.request('/v1/me', { headers: { authorization: `Bearer ${token}` } });
  const clan = await (await post(alice.token, '/v1/clans', { name: 'Membership' })).json();
  const join = async (user: typeof bob) => {
    const invitation = await (
      await post(alice.token, `/v1/clans/${clan.id}/invitations`, { email: user.user.email })
    ).json();
    assert.equal((await post(user.token, '/v1/invitations/join', { code: invitation.code })).status, 200);
  };
  await join(bob);
  await join(carol);
  const remove = (token: string, userId: string) => post(token, `/v1/clans/${clan.id}/members/${userId}/remove`);
  const bobAgent = await (await post(bob.token, `/v1/clans/${clan.id}/agents`, { name: 'Codex' })).json();
  // Only the leader removes others; agents cannot; the leader cannot leave or be removed.
  assert.equal((await remove(carol.token, bob.user.id)).status, 403);
  assert.equal((await remove(bobAgent.token, carol.user.id)).status, 403);
  assert.equal((await post(bobAgent.token, `/v1/clans/${clan.id}/leave`)).status, 403);
  assert.equal((await remove(alice.token, alice.user.id)).status, 409);
  assert.equal((await post(alice.token, `/v1/clans/${clan.id}/leave`)).status, 409);
  assert.equal((await remove(alice.token, randomUUID())).status, 404);
  assert.equal((await remove(alice.token, 'not-a-uuid')).status, 404);
  assert.equal((await post(alice.token, `/v1/clans/${clan.id}/members/${bob.user.id}/remove`, { x: 1 })).status, 400);
  // Removal ends access for the member and their agents, and re-invitation does not revive old agent tokens.
  assert.deepEqual(await (await remove(alice.token, bob.user.id)).json(), { removed: true });
  assert.equal((await me(bobAgent.token)).status, 401);
  assert.equal(
    (await app.request(`/v1/clans/${clan.id}/members`, { headers: { authorization: `Bearer ${bob.token}` } })).status,
    404,
  );
  await join(bob);
  assert.equal((await me(bobAgent.token)).status, 401);
  // Members can leave on their own.
  assert.deepEqual(await (await post(carol.token, `/v1/clans/${clan.id}/leave`)).json(), { left: true });
  assert.equal((await post(carol.token, `/v1/clans/${clan.id}/leave`)).status, 404);
  // An agent registered concurrently with removal either fails or loses its token; it never keeps access.
  for (let round = 0; round < 5; round++) {
    const [removed, registered] = await Promise.all([
      remove(alice.token, bob.user.id),
      post(bob.token, `/v1/clans/${clan.id}/agents`, { name: `Racer ${round}` }),
    ]);
    assert.equal(removed.status, 200);
    if (registered.status === 201) assert.equal((await me((await registered.json()).token)).status, 401);
    else assert.equal(registered.status, 404);
    await join(bob);
  }
  const [orphans] = await sql`
    select count(*)::integer as n from credentials c join agents a on a.id = c.agent_id
    where a.clan_id = ${clan.id} and a.owner_id = ${bob.user.id}`;
  assert.equal(orphans?.n, 0);
  const types =
    await sql`select type from events where clan_id = ${clan.id} and type in ('member.removed', 'member.left')`;
  assert.equal(types.filter((row) => row.type === 'member.left').length, 1);
});
