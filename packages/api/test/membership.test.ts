import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { hashToken } from '../src/db/store.js';
import { database, skip } from './postgres.js';

test('PostgreSQL: leaders remove members or hand off leadership, members leave, and agent tokens never outlive membership', {
  skip,
}, async (t) => {
  const { sql, connection, user } = await database(t);
  const alice = await user();
  const bob = await user();
  const carol = await user();
  const app = createApp(connection.store, connection.db);
  const post = (token: string, path: string, body: object = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const me = (token: string) => app.request('/v1/me', { headers: { authorization: `Bearer ${token}` } });
  const clan = await (await post(alice.token, '/v1/clans', { name: 'Membership' })).json();
  const invite = async (user: typeof bob) => {
    const response = await post(alice.token, `/v1/clans/${clan.id}/invitations`, { email: user.user.email });
    assert.equal(response.status, 201);
    return response.json();
  };
  const pending = (token: string) => app.request('/v1/invitations', { headers: { authorization: `Bearer ${token}` } });
  const accept = (token: string) => post(token, '/v1/invitations/accept', { clanId: clan.id });
  const join = async (user: typeof bob) => {
    const invitation = await invite(user);
    assert.equal((await post(user.token, '/v1/invitations/join', { code: invitation.code })).status, 200);
  };
  const firstBobInvite = await invite(bob);
  const secondBobInvite = await invite(bob);
  assert.deepEqual(await (await pending(alice.token)).json(), { invitations: [] });
  assert.equal((await accept(carol.token)).status, 404);
  // An existing sign-in can list and accept invitations sent after it.
  assert.deepEqual(await (await pending(bob.token)).json(), {
    invitations: [{ clanId: clan.id, clanName: clan.name, expiresAt: secondBobInvite.expiresAt }],
  });
  const joins = await Promise.all([accept(bob.token), accept(bob.token)]);
  // Accepting consumes both invitations, so the concurrent duplicate finds nothing left.
  assert.deepEqual(joins.map((response) => response.status).sort(), [200, 404]);
  assert.deepEqual(await (await pending(bob.token)).json(), { invitations: [] });
  const expired = await invite(carol);
  await sql`update invitations set expires_at = now() - interval '1 second' where code_hash = ${hashToken(expired.code)}`;
  assert.equal((await accept(carol.token)).status, 404);
  assert.deepEqual(await (await pending(carol.token)).json(), { invitations: [] });
  await join(carol);
  const remove = (token: string, userId: string) => post(token, `/v1/clans/${clan.id}/members/${userId}/remove`);
  const bobAgent = await (await post(bob.token, `/v1/clans/${clan.id}/agents`, { name: 'Codex' })).json();
  assert.equal((await pending(bobAgent.token)).status, 403);
  assert.equal((await accept(bobAgent.token)).status, 403);
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
  assert.equal((await accept(bob.token)).status, 404);
  assert.equal((await post(bob.token, '/v1/invitations/join', { code: firstBobInvite.code })).status, 404);
  assert.deepEqual(await (await pending(bob.token)).json(), { invitations: [] });
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
  // Leadership moves only by the leader's personal credential, and only to a current member.
  const transfer = (token: string, userId: unknown) => post(token, `/v1/clans/${clan.id}/leader`, { userId });
  const leaders = async () =>
    (await sql`select user_id from memberships where clan_id = ${clan.id} and role = 'leader'`).map(
      (row) => row.user_id,
    );
  const bobAgentAgain = await (await post(bob.token, `/v1/clans/${clan.id}/agents`, { name: 'Again' })).json();
  assert.equal((await transfer(bob.token, bob.user.id)).status, 403);
  assert.equal((await transfer(bobAgentAgain.token, bob.user.id)).status, 403);
  assert.equal((await transfer(alice.token, alice.user.id)).status, 400);
  assert.equal((await transfer(alice.token, 'not-a-uuid')).status, 400);
  assert.equal((await transfer(alice.token, carol.user.id)).status, 404);
  const orchestrator = await (
    await post(alice.token, `/v1/clans/${clan.id}/agents`, { name: 'Lead', role: 'orchestrator' })
  ).json();
  // Concurrent transfers and removals leave exactly one leader.
  await join(carol);
  const raced = await Promise.all([transfer(alice.token, bob.user.id), transfer(alice.token, carol.user.id)]);
  assert.deepEqual(raced.map((r) => r.status).sort(), [200, 403]);
  assert.equal((await leaders()).length, 1);
  const [winner] = await leaders();
  const other = winner === bob.user.id ? carol : bob;
  const newLeader = winner === bob.user.id ? bob : carol;
  // The old orchestrator keeps working as a worker, and the new leader can register their own.
  const [demoted] = await sql`select role from agents where id = ${orchestrator.agent.id}`;
  assert.equal(demoted?.role, 'worker');
  assert.equal(
    (await post(newLeader.token, `/v1/clans/${clan.id}/agents`, { name: 'Next', role: 'orchestrator' })).status,
    201,
  );
  // Whichever commits first wins: a transfer demotes the remover, and a removal leaves nobody to promote.
  const [handedOff, removed] = await Promise.all([
    transfer(newLeader.token, alice.user.id),
    remove(newLeader.token, alice.user.id),
  ]);
  const outcome = [handedOff.status, removed.status];
  assert.ok([200, 403].join() === outcome.join() || [404, 200].join() === outcome.join(), outcome.join());
  assert.equal((await leaders()).length, 1);
  // A former leader can leave once someone else leads.
  if (handedOff.status === 200) {
    assert.equal((await transfer(alice.token, newLeader.user.id)).status, 200);
    assert.deepEqual(await (await post(alice.token, `/v1/clans/${clan.id}/leave`)).json(), { left: true });
  }
  assert.deepEqual(await leaders(), [newLeader.user.id]);
  assert.equal((await remove(newLeader.token, other.user.id)).status, 200);
  const [changes] =
    await sql`select count(*)::integer as n from events where clan_id = ${clan.id} and type = 'clan.leader_changed'`;
  assert.equal(changes?.n, handedOff.status === 200 ? 3 : 1);
});
