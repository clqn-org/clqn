import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createApp } from '../src/app.js';
import { createStore } from '../src/db/store.js';

test('PostgreSQL: linked repositories accept merges only from signed GitHub pull request events', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
}, async (t) => {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 5 });
  const connection = createStore(process.env.TEST_DATABASE_URL!);
  const userIds: string[] = [];
  const clanIds: string[] = [];
  t.after(async () => {
    try {
      if (clanIds.length) {
        await sql`delete from github_deliveries where binding_id in (select id from linked_repositories where clan_id in ${sql(clanIds)})`;
        await sql`delete from linked_repositories where clan_id in ${sql(clanIds)}`;
        await sql`delete from events where clan_id in ${sql(clanIds)}`;
        await sql`delete from tasks where clan_id in ${sql(clanIds)}`;
        await sql`delete from credentials where user_id in ${sql(userIds)}`;
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
  userIds.push(alice.user.id);
  const clan = await connection.store.createClan(alice.user.id, 'Merge confirmation');
  clanIds.push(clan.id);
  const master = 'm'.repeat(32);
  const app = createApp(connection.store, connection.db, { githubWebhookSecret: master });
  const api = (suffix: string, body?: object) =>
    app.request(`/v1/clans/${clan.id}${suffix}`, {
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const setup = await (await api('/repositories', { slug: 'example/merges' })).json();
  const head = 'b'.repeat(40);
  // Each task gets a claimed branch with a reported head and pull request.
  const codeTask = async (prNumber: number) => {
    const repository = { slug: 'example/merges', baseSha: 'a'.repeat(40), branch: `clqn/pr-${prNumber}` };
    const task = await (await api('/tasks', { description: `PR ${prNumber}`, repository })).json();
    assert.equal((await api(`/tasks/${task.id}/claim`, {})).status, 200);
    const prUrl = `https://github.com/example/merges/pull/${prNumber}`;
    const report = { expectedHeadSha: null, headSha: head, prNumber, prUrl };
    assert.equal((await api(`/tasks/${task.id}/repository`, report)).status, 200);
    return task.id as string;
  };
  const integrate = (taskId: string, mergeCommitSha = 'c'.repeat(40)) =>
    api(`/tasks/${taskId}/integration`, { headSha: head, mergeCommitSha });
  const state = async (taskId: string) => (await (await api(`/tasks/${taskId}`)).json()).repository;
  const signed = (body: object, delivery = randomUUID()) => {
    const raw = JSON.stringify(body);
    const secret = createHmac('sha256', master).update(setup.repository.id).digest('hex');
    return app.request(setup.webhook.path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': delivery,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      },
      body: raw,
    });
  };
  const pullRequest = (number: number, merged: boolean, sha = head, mergeCommitSha = 'd'.repeat(40)) => ({
    action: 'closed',
    number,
    pull_request: { merged, merge_commit_sha: merged ? mergeCommitSha : null, head: { sha } },
    repository: { full_name: 'Example/Merges' },
  });
  // Links that have never sent pull request events keep accepting the orchestrator's report.
  const legacy = await codeTask(1);
  assert.equal((await (await integrate(legacy)).json()).repository.state, 'merged');
  // The first signed pull request event switches the link to GitHub confirmation.
  const opened = { ...pullRequest(2, false), action: 'opened' };
  assert.deepEqual(await (await signed(opened)).json(), { accepted: true, ignored: true });
  const confirmed = await codeTask(2);
  const reported = await integrate(confirmed);
  assert.equal(reported.status, 200);
  assert.equal((await reported.json()).repository.state, 'open');
  const early = await api(`/tasks/${confirmed}/complete`, {});
  assert.equal(early.status, 409);
  assert.match((await early.json()).error.message, /GitHub must confirm the merge/);
  // Closed without merging, or merged from a different head, confirms nothing.
  assert.equal((await (await signed(pullRequest(2, false))).json()).integrated, undefined);
  assert.equal((await (await signed(pullRequest(2, true, 'e'.repeat(40)))).json()).integrated, 0);
  assert.equal((await signed({ ...pullRequest(2, true), number: 'two' })).status, 400);
  assert.equal((await signed({ ...pullRequest(2, true), repository: { full_name: 'other/repository' } })).status, 400);
  assert.equal((await state(confirmed)).state, 'open');
  // A matching merge is recorded with GitHub's merge commit, once, even when redelivered.
  const delivery = randomUUID();
  assert.equal((await (await signed(pullRequest(2, true), delivery)).json()).integrated, 1);
  assert.equal((await (await signed(pullRequest(2, true), delivery)).json()).duplicate, true);
  assert.equal((await (await signed(pullRequest(2, true))).json()).integrated, 0);
  assert.deepEqual(
    { state: (await state(confirmed)).state, mergeCommitSha: (await state(confirmed)).mergeCommitSha },
    { state: 'merged', mergeCommitSha: 'd'.repeat(40) },
  );
  // A late client report must agree with GitHub's merge commit.
  assert.equal((await integrate(confirmed)).status, 409);
  assert.equal((await integrate(confirmed, 'd'.repeat(40))).status, 200);
  assert.equal((await api(`/tasks/${confirmed}/complete`, {})).status, 200);
  // A client report racing the webhook never marks the task merged on its own, and one event is recorded.
  const raced = await codeTask(3);
  const [clientReport, webhook] = await Promise.all([integrate(raced), signed(pullRequest(3, true))]);
  assert.ok([200, 409].includes(clientReport.status));
  assert.equal((await webhook.json()).integrated, 1);
  assert.equal((await state(raced)).mergeCommitSha, 'd'.repeat(40));
  const [events] = await sql`
    select count(*)::integer as n, min(actor_id::text) as actor from events
    where clan_id = ${clan.id} and type = 'task.integrated' and resource_id in ${sql([confirmed, raced])}`;
  assert.deepEqual({ ...events }, { n: 2, actor: alice.user.id });
});
