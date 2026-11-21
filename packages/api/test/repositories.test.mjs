import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { linkedRepositorySchema, linkedRepositorySetupSchema } from '@clqn/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createApp } from '../dist/app.js';
import { createStore } from '../dist/store.js';

const master = '0123456789abcdef'.repeat(4);
test('webhook configuration fails closed and setup schemas constrain secret destinations', async () => {
  assert.throws(() => createApp(undefined, undefined, { githubWebhookSecret: 'short' }), /GITHUB_WEBHOOK_SECRET/);
  const app = createApp();
  const response = await app.request(`/hooks/github/${randomUUID()}`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'WEBHOOK_UNAVAILABLE');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const oversized = await app.request(`/hooks/github/${randomUUID()}`, {
    method: 'POST',
    body: 'x'.repeat(2 * 1024 * 1024 + 1),
  });
  assert.equal(oversized.status, 413);
  const repository = {
    id: randomUUID(),
    clanId: randomUUID(),
    slug: 'test/project',
    createdAt: new Date().toISOString(),
    lastEventSequence: 0,
  };
  for (const path of [
    'https://evil.example/hook',
    '//evil.example/hook',
    '/hooks/github/../etc',
    `/hooks/github/${'a'.repeat(36)}`,
  ]) {
    assert.equal(
      linkedRepositorySetupSchema.safeParse({ repository, webhook: { path, secret: 'a'.repeat(64) } }).success,
      false,
    );
  }
});

test('PostgreSQL: scoped repository links authenticate raw webhooks, deduplicate concurrent delivery, and revoke atomically', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const sql = postgres(process.env.TEST_DATABASE_URL, { max: 5 });
  const connection = createStore(process.env.TEST_DATABASE_URL);
  const clanIds = [];
  const userIds = [];
  t.after(async () => {
    try {
      if (clanIds.length) {
        await sql`delete from linked_repositories where clan_id in ${sql(clanIds)}`;
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
  const clan = await connection.store.createClan(alice.user.id, 'Webhook test');
  const other = await connection.store.createClan(bob.user.id, 'Other webhook clan');
  clanIds.push(clan.id, other.id);
  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${bob.user.id})`;
  const worker = await connection.store.registerAgent(bob.user, clan.id, 'Worker');
  const orchestrator = await connection.store.registerAgent(alice.user, clan.id, 'Coordinator', 'orchestrator');
  const app = createApp(connection.store, connection.db, { githubWebhookSecret: master });
  const unavailable = createApp(connection.store, connection.db);
  const request = (token, path = '', body, clanId = clan.id, target = app) =>
    target.request(`/v1/clans/${clanId}/repositories${path}`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  for (const token of [bob.token, worker.token, orchestrator.token]) {
    assert.equal((await request(token, '', { slug: 'test/project' })).status, 403);
  }
  assert.equal((await request(alice.token, '', { slug: 'test/project' }, other.id)).status, 404);
  assert.equal((await request(alice.token, '', { slug: 'test/project' }, clan.id, unavailable)).status, 503);
  assert.equal((await request(alice.token, '', { slug: 'https://github.com/test/project' })).status, 400);
  const setups = await Promise.all([
    request(alice.token, '', { slug: 'Test/Project' }),
    request(alice.token, '', { slug: 'test/project' }),
  ]);
  assert.deepEqual(
    setups.map((r) => r.status),
    [200, 200],
  );
  const [setup, repeated] = await Promise.all(
    setups.map(async (response) => linkedRepositorySetupSchema.parse(await response.json())),
  );
  assert.deepEqual(setup, repeated);
  assert.equal(setup.repository.slug, 'test/project');
  assert.equal(setup.webhook.secret, createHmac('sha256', master).update(setup.repository.id).digest('hex'));
  const [stored] = await sql`select * from linked_repositories where id = ${setup.repository.id}`;
  assert.ok(!JSON.stringify(stored).includes(setup.webhook.secret));
  const metadataResponse = await request(worker.token, `/${setup.repository.id}`);
  assert.deepEqual(await metadataResponse.json(), setup.repository);
  assert.equal((await request(alice.token, `/${setup.repository.id}`, undefined, other.id)).status, 404);
  assert.equal((await request(worker.token, '', undefined, other.id)).status, 404);
  const listed = await (await request(worker.token)).json();
  assert.deepEqual(listed.repositories, [setup.repository]);
  assert.ok(!JSON.stringify(listed).includes(setup.webhook.secret));
  const push = {
    repository: { full_name: 'Test/Project' },
    ref: 'refs/heads/main',
    after: 'a'.repeat(40),
    deleted: false,
    commits: [{ message: 'Unicode résumé 🐈' }],
  };
  const signed = (
    body,
    {
      event = 'push',
      delivery = randomUUID(),
      secret = setup.webhook.secret,
      path = setup.webhook.path,
      signature,
    } = {},
  ) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': delivery,
        'x-hub-signature-256': signature ?? `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      },
      body: raw,
    });
  };
  assert.equal((await signed(push, { signature: `sha256=${'0'.repeat(64)}` })).status, 401);
  const tampered = `${JSON.stringify(push)} `;
  const signature = `sha256=${createHmac('sha256', setup.webhook.secret).update(JSON.stringify(push)).digest('hex')}`;
  assert.equal((await signed(tampered, { signature })).status, 401);
  assert.equal((await signed(push, { secret: master })).status, 401);
  assert.equal((await signed(push, { signature: 'sha256=abc' })).status, 401);
  assert.equal((await signed(push, { delivery: 'invalid' })).status, 400);
  assert.equal((await signed('not json')).status, 400);
  assert.equal((await signed({ ...push, repository: { full_name: 'other/project' } })).status, 400);
  assert.equal((await signed({}, { event: 'ping' })).status, 200);
  assert.equal((await signed(push, { event: 'issues' })).status, 202);
  assert.equal((await signed({ ...push, ref: 'refs/heads/task/one' })).status, 200);
  assert.equal((await signed({ ...push, ref: 'refs/tags/main' })).status, 200);
  const before = linkedRepositorySchema.parse(await (await request(alice.token, `/${setup.repository.id}`)).json());
  assert.equal(before.lastEventSequence, 0);
  const delivery = randomUUID();
  const responses = await Promise.all([signed(push, { delivery }), signed(push, { delivery })]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  );
  const outcomes = await Promise.all(responses.map((r) => r.json()));
  assert.equal(outcomes.filter((result) => result.duplicate).length, 1);
  const received = linkedRepositorySchema.parse(await (await request(worker.token, `/${setup.repository.id}`)).json());
  assert.ok(received.lastEventSequence > 0);
  const sameDeliveryDifferentBody = await signed({ ...push, after: 'b'.repeat(40) }, { delivery });
  assert.equal((await sameDeliveryDifferentBody.json()).duplicate, true);
  const ignoredDelivery = randomUUID();
  await signed({ ...push, ref: 'refs/heads/other' }, { delivery: ignoredDelivery });
  assert.equal((await (await signed(push, { delivery: ignoredDelivery })).json()).duplicate, true);
  const [events] =
    await sql`select count(*)::integer as n from events where clan_id = ${clan.id} and type = 'repository.main_changed'`;
  assert.equal(events.n, 1);
  const [audit] = await sql`select * from events where clan_id = ${clan.id} and type = 'repository.main_changed'`;
  assert.equal(audit.actor_id, alice.user.id);
  assert.equal(audit.resource_id, 'test/project');
  assert.equal(Number(audit.sequence), received.lastEventSequence);
  assert.ok(!JSON.stringify(audit).includes('Unicode'));
  // Main deletion still creates a notification, but never deletes or changes local code on the server.
  const deletion = await signed({ ...push, deleted: true, after: '0'.repeat(40) });
  assert.equal(deletion.status, 200);
  assert.equal((await request(worker.token, `/${setup.repository.id}/unlink`, {})).status, 403);
  assert.equal((await request(alice.token, `/${setup.repository.id}/unlink`, {}, other.id)).status, 404);
  // Delivery and unlink serialize on the binding; the hook cannot record an event after revocation commits.
  const concurrent = await Promise.all([signed(push), request(alice.token, `/${setup.repository.id}/unlink`, {})]);
  assert.equal(concurrent[1].status, 200);
  assert.ok([200, 404].includes(concurrent[0].status));
  assert.equal((await signed(push)).status, 404);
  assert.equal((await request(alice.token, `/${setup.repository.id}`)).status, 404);
  const [deliveries] =
    await sql`select count(*)::integer as n from github_deliveries where binding_id = ${setup.repository.id}`;
  assert.equal(deliveries.n, 0);
  const [links] =
    await sql`select count(*)::integer as n from events where clan_id = ${clan.id} and type = 'repository.linked'`;
  assert.equal(links.n, 1);
});
