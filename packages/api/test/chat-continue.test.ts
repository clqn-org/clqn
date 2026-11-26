import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  chatInboxSchema,
  chatStateSchema,
  defaultChatSettings,
  linkedRepositorySetupSchema,
  taskSchema,
} from '@clqn/shared';
import { createApp } from '../src/app.js';
import { database, skip } from './postgres.js';

test('PostgreSQL: a follow-up continues a stopped or published chat task with its worker', { skip }, async (t) => {
  const { sql, connection, user } = await database(t);
  const [leader, member] = await Promise.all([user(), user()]);
  const clan = await connection.store.createClan(leader.user.id, 'Continue chat work');
  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${member.user.id})`;
  const orchestrator = await connection.store.registerAgent(leader.user, clan.id, 'Orchestrator', 'orchestrator');
  const worker = await connection.store.registerAgent(member.user, clan.id, 'Worker');
  const other = await connection.store.registerAgent(member.user, clan.id, 'Other worker');
  const app = createApp(connection.store, connection.db, { githubWebhookSecret: 'm'.repeat(32) });
  const request = (token: string, path: string, body?: object) =>
    app.request(`/v1/clans/${clan.id}${path}`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
  const state = async (token = member.token) =>
    chatStateSchema.parse(await (await request(token, '/chat/state')).json());
  const slug = 'example/continue';
  const link = linkedRepositorySetupSchema.parse(await (await request(leader.token, '/repositories', { slug })).json());
  assert.equal((await request(leader.token, '/chat/join', defaultChatSettings)).status, 200);
  assert.equal((await request(member.token, '/chat/join', defaultChatSettings)).status, 200);

  // Manual approval: every delegation, including a continuation, waits for the worker owner's yes.
  async function delegate(title: string, extra: object = {}) {
    const id = randomUUID();
    assert.equal((await request(member.token, '/chat/messages', { id, text: title })).status, 201);
    const response = await request(orchestrator.token, `/chat/messages/${id}/decision`, {
      action: 'delegate',
      title,
      description: `Do: ${title}`,
      workerId: worker.agent.id,
      estimatedTokens: 12,
      ...extra,
    });
    return { id, response };
  }
  async function approved(title: string, extra: object = {}) {
    const { id, response } = await delegate(title, extra);
    assert.deepEqual(await response.json(), { status: 'approval', blocker: null });
    const approval = await request(member.token, `/chat/messages/${id}/approval`, { approve: true });
    assert.equal(approval.status, 200, await approval.clone().text());
    return id;
  }
  const run = async (messageId: string) => (await state()).runs.find((entry) => entry.messageId === messageId);

  const first = await approved('Build the feature');
  const taskId = (await run(first))!.taskId;
  const task = `/tasks/${taskId}`;
  assert.equal((await request(worker.token, `${task}/claim`, {})).status, 200);
  assert.equal((await request(worker.token, `/chat/tasks/${taskId}/usage`, { tokens: 30 })).status, 200);

  // Continuing needs the task to be stopped or in review, and its own worker.
  const busy = await delegate('Too early', { taskId });
  assert.equal(busy.response.status, 409);
  assert.equal((await request(worker.token, `${task}/release`, {})).status, 200);
  assert.equal((await run(first))?.status, 'released');
  const elsewhere = await delegate('Wrong worker', { taskId, workerId: other.agent.id });
  assert.equal(elsewhere.response.status, 409);
  assert.equal((await delegate('Unknown task', { taskId: randomUUID() })).response.status, 404);

  const inbox = chatInboxSchema.parse(await (await request(orchestrator.token, '/chat/inbox', {})).json());
  assert.ok(inbox.runs?.some((entry) => entry.taskId === taskId && entry.status === 'released'));

  // The retry moves the task, with its usage, to the new delegation.
  const retry = await approved('Finish the feature', { taskId });
  assert.equal(await run(first), undefined);
  const retried = (await run(retry))!;
  assert.equal(retried.taskId, taskId);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.tokens, 30);
  assert.equal(retried.estimatedTokens, 42);
  assert.deepEqual((await state()).usage, { tokens: 30, reserved: 12, agents: 1 });
  assert.equal(
    taskSchema.parse(await (await request(member.token, task)).json()).description,
    'Do: Finish the feature',
  );
  assert.equal((await delegate('Queued already', { taskId })).response.status, 409);
  assert.equal((await request(other.token, `${task}/claim`, {})).status, 409);
  assert.equal((await request(worker.token, `${task}/claim`, {})).status, 200);
  assert.equal((await request(worker.token, `/chat/tasks/${taskId}/usage`, { tokens: 20 })).status, 409);
  assert.equal((await request(worker.token, `/chat/tasks/${taskId}/usage`, { tokens: 50 })).status, 200);

  // Publish, then follow up on the open pull request.
  const repository = { slug, branch: `clqn/task-${taskId}`, baseBranch: 'main', baseSha: 'a'.repeat(40) };
  assert.equal((await request(worker.token, `${task}/chat-repository`, repository)).status, 200);
  const prNumber = 9;
  const prUrl = `https://github.com/${slug}/pull/${prNumber}`;
  const head = 'b'.repeat(40);
  const report = (headSha: string, expectedHeadSha: string | null) =>
    request(worker.token, `${task}/repository`, { headSha, expectedHeadSha, prNumber, prUrl });
  assert.equal((await report(head, null)).status, 200);
  assert.equal((await request(leader.token, `${task}/merge-approval`, { headSha: head, approved: true })).status, 200);
  assert.equal((await state(leader.token)).mergeQueue?.length, 1);
  assert.deepEqual((await state()).usage, { tokens: 50, reserved: 0, agents: 0 });

  const followUp = await approved('Address review', { taskId });
  const continued = taskSchema.parse(await (await request(member.token, task)).json());
  assert.equal(continued.status, 'open');
  assert.equal(continued.assignedAgentId, worker.agent.id);
  assert.equal(continued.repository?.state, 'pending');
  assert.equal(continued.repository?.headSha, head);
  assert.equal(continued.repository?.prNumber, prNumber);
  assert.equal(continued.repository?.mergeApproval, undefined);
  assert.deepEqual((await state(leader.token)).mergeQueue, []);
  assert.deepEqual((await state()).usage, { tokens: 50, reserved: 12, agents: 1 });
  assert.equal((await run(followUp))?.status, 'queued');
  assert.equal((await request(worker.token, `${task}/claim`, {})).status, 200);
  assert.equal((await state()).running, 1);

  // GitHub confirming a merge of the old head does not complete the run that is still working.
  const raw = JSON.stringify({
    action: 'closed',
    number: prNumber,
    pull_request: {
      merged: true,
      merge_commit_sha: 'd'.repeat(40),
      head: { sha: head, ref: repository.branch, repo: { full_name: slug } },
      base: { ref: 'main' },
    },
    repository: { full_name: slug },
  });
  const merged = await app.request(link.webhook.path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': `sha256=${createHmac('sha256', link.webhook.secret).update(raw).digest('hex')}`,
    },
    body: raw,
  });
  assert.deepEqual(await merged.json(), { accepted: true, integrated: 0 });
  assert.equal(taskSchema.parse(await (await request(member.token, task)).json()).status, 'claimed');

  // Reporting the head ends the pending state, even when the worker made no new commit.
  assert.equal((await report(head, head)).status, 200);
  const reviewed = taskSchema.parse(await (await request(member.token, task)).json());
  assert.equal(reviewed.repository?.state, 'open');
  assert.equal((await state()).running, 0);
  assert.equal((await state()).usage.agents, 0);

  // A task released after binding but before its first push counts against limits when continued.
  assert.equal((await request(member.token, '/chat/join', { ...defaultChatSettings, agentLimit: 1 })).status, 200);
  const unpushed = (await run(await approved('Second feature')))!.taskId;
  assert.equal((await request(worker.token, `/tasks/${unpushed}/claim`, {})).status, 200);
  const unpushedBranch = { ...repository, branch: `clqn/task-${unpushed}` };
  assert.equal((await request(worker.token, `/tasks/${unpushed}/chat-repository`, unpushedBranch)).status, 200);
  assert.equal((await request(worker.token, `/tasks/${unpushed}/release`, {})).status, 200);
  await approved('Finish the second feature', { taskId: unpushed });
  const resumed = taskSchema.parse(await (await request(member.token, `/tasks/${unpushed}`)).json());
  assert.equal(resumed.repository, null);
  assert.equal((await state()).usage.agents, 1);
  const blocked = await delegate('One too many', { workerId: other.agent.id });
  assert.deepEqual(await blocked.response.json(), { status: 'approval', blocker: null });
  const limited = await request(member.token, `/chat/messages/${blocked.id}/approval`, { approve: true });
  assert.equal(limited.status, 409);
  assert.match(await limited.text(), /agent limit/);
});
