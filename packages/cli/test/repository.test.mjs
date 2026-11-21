import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const clanId = 'bf689cc3-c719-4ce6-a681-d56b43526fed';
const userId = '59b55e8d-0eb5-42fb-aead-f9e665406277';
const otherUserId = '579019b4-aefc-46df-a268-b67c591d5cd0';
const taskId = '7630f779-401b-4fe3-b7ba-b624dfc0e92d';
const agentId = 'e0d647e2-03ef-484c-94af-872964e2bfec';
const otherAgentId = '07f58917-2325-43db-9dd4-9d5a38ff1d40';
const baseSha = 'a'.repeat(40);
const repository = {
  slug: 'example/project',
  baseBranch: 'main',
  baseSha,
  branch: 'clqn/task-1',
  headSha: null,
  prNumber: null,
  prUrl: null,
  mergeCommitSha: null,
  state: 'pending',
};
const initialTask = {
  id: taskId,
  clanId,
  description: 'Implement endpoint',
  status: 'open',
  ownerId: null,
  ownerAgentId: null,
  assignedAgentId: null,
  repository: null,
  createdAt: '2026-11-14T12:00:00.000Z',
  updatedAt: '2026-11-14T12:00:00.000Z',
};

async function fixture(
  t,
  { actor = { id: userId, email: 'member@example.com' }, task = initialTask, role = 'member' } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'clqn-repository-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = `clqn_${'r'.repeat(43)}`;
  const requests = [];
  let value = { ...task };
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }));
      return;
    }
    if (request.url === '/v1/me') response.end(JSON.stringify(actor));
    else if (request.url === '/v1/agent')
      response.end(
        JSON.stringify({
          id: actor.agentId,
          ownerId: actor.id,
          clanId,
          name: 'Worker',
          role: 'worker',
          createdAt: initialTask.createdAt,
        }),
      );
    else if (request.url === `/v1/clans/${clanId}/members`)
      response.end(
        JSON.stringify({
          members: [
            {
              userId: actor.id,
              email: actor.email,
              role,
              createdAt: initialTask.createdAt,
            },
          ],
        }),
      );
    else if (request.url === `/v1/clans/${clanId}/agents` && request.method === 'POST') {
      response.writeHead(201);
      response.end(
        JSON.stringify({
          agent: {
            id: agentId,
            ownerId: actor.id,
            clanId,
            name: body.name,
            role: body.role,
            createdAt: initialTask.createdAt,
          },
          token,
        }),
      );
    } else if (request.url === `/v1/clans/${clanId}/tasks` && request.method === 'POST') {
      value = {
        ...initialTask,
        description: body.description,
        repository: body.repository ? { ...repository, ...body.repository } : null,
      };
      response.writeHead(201);
      response.end(JSON.stringify(value));
    } else if (request.url === `/v1/clans/${clanId}/tasks/${taskId}/assign` && request.method === 'POST') {
      value = { ...value, assignedAgentId: body.agentId };
      response.end(JSON.stringify(value));
    } else if (request.url === `/v1/clans/${clanId}/tasks/${taskId}/claim` && request.method === 'POST') {
      value = { ...value, status: 'claimed', ownerId: actor.id };
      response.end(JSON.stringify(value));
    } else if (
      request.method === 'GET' &&
      [value.id, value.alias].filter(Boolean).some((ref) => request.url === `/v1/clans/${clanId}/tasks/${ref}`)
    )
      response.end(JSON.stringify(value));
    else {
      response.writeHead(404);
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const executions = join(directory, 'executions');
  // These sentinels make an unexpected subprocess visible without contacting GitHub.
  for (const executable of ['git', 'gh'])
    await writeFile(join(bin, executable), '#!/bin/sh\necho invoked >> "$CLQN_TEST_EXECUTIONS"\nexit 91\n', {
      mode: 0o700,
    });
  const call = (args) =>
    run(process.execPath, [cli, '--api-url', apiUrl, ...args], {
      env: {
        ...process.env,
        CLQN_CONFIG_DIR: join(directory, 'config'),
        CLQN_TOKEN: token,
        CLQN_CLAN_ID: clanId,
        CLQN_TEST_EXECUTIONS: executions,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
  const assertNoExecutions = () => assert.rejects(readFile(executions), { code: 'ENOENT' });
  return { call, requests, directory, token, assertNoExecutions };
}

test('repository task creation and assignment send structured API requests', async (t) => {
  const f = await fixture(t);
  const created = JSON.parse(
    (
      await f.call([
        'task',
        'add',
        'Implement endpoint',
        '--repo',
        'Example/Project',
        '--base-sha',
        baseSha,
        '--branch',
        'clqn/task-1',
        '--json',
      ])
    ).stdout,
  );
  assert.deepEqual(f.requests[0], {
    method: 'POST',
    path: `/v1/clans/${clanId}/tasks`,
    authorization: `Bearer ${f.token}`,
    body: {
      description: 'Implement endpoint',
      repository: {
        slug: 'example/project',
        baseBranch: 'main',
        baseSha,
        branch: 'clqn/task-1',
      },
    },
  });
  assert.deepEqual(created.repository, repository);
  const assigned = JSON.parse((await f.call(['task', 'assign', taskId, '--agent', agentId, '--json'])).stdout);
  assert.deepEqual(f.requests[1].body, { agentId });
  assert.equal(f.requests[1].path, `/v1/clans/${clanId}/tasks/${taskId}/assign`);
  assert.equal(assigned.assignedAgentId, agentId);
  const shown = JSON.parse((await f.call(['task', 'show', taskId, '--json'])).stdout);
  assert.deepEqual(shown, assigned);
});

test('partial or unsafe repository arguments fail before API or Git access', async (t) => {
  const f = await fixture(t);
  for (const options of [
    ['--repo', 'example/project'],
    ['--base-sha', baseSha],
    ['--branch', 'task/one'],
    ['--base-branch', 'main'],
    ['--repo', 'https://github.com/example/project', '--base-sha', baseSha, '--branch', 'task/one'],
    ['--repo', 'example/project', '--base-sha', 'abc', '--branch', 'task/one'],
    ['--repo', 'example/project', '--base-sha', baseSha, '--branch', 'main'],
    ['--repo', 'example/project', '--base-sha', baseSha, '--branch', 'task/../other'],
  ])
    await assert.rejects(f.call(['task', 'add', 'Invalid task', ...options, '--json']), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.equal(JSON.parse(error.stderr).error.code, 'COMMAND_FAILED');
      return true;
    });
  assert.equal(f.requests.length, 0);
  await f.assertNoExecutions();
});

test('starting work by alias claims the UUID returned by the lookup', async (t) => {
  const f = await fixture(t, { task: { ...initialTask, alias: 'login-fix' } });
  const started = await f.call(['task', 'start', 'login-fix']);
  assert.ok(started.stdout.includes(`login-fix (${taskId})`));
  assert.deepEqual(
    f.requests.map((req) => req.path),
    [`/v1/clans/${clanId}/tasks/login-fix`, '/v1/me', `/v1/clans/${clanId}/tasks/${taskId}/claim`],
  );
});

test('agent add forwards an explicit orchestrator role and defaults to worker', async (t) => {
  const f = await fixture(t);
  const orchestrator = JSON.parse((await f.call(['agent', 'add', 'Coordinator', '--orchestrator', '--json'])).stdout);
  assert.deepEqual(f.requests[0].body, { name: 'Coordinator', role: 'orchestrator' });
  assert.equal(orchestrator.agent.role, 'orchestrator');
  const worker = JSON.parse((await f.call(['agent', 'add', 'Worker', '--json'])).stdout);
  assert.deepEqual(f.requests[1].body, { name: 'Worker', role: 'worker' });
  assert.equal(worker.agent.role, 'worker');
});

test('start and submit reject another owner before invoking Git or GitHub', async (t) => {
  const f = await fixture(t, { task: { ...initialTask, status: 'claimed', ownerId: otherUserId, repository } });
  for (const action of ['start', 'submit'])
    await assert.rejects(
      f.call(['task', action, taskId, '--path', join(f.directory, 'worktree'), '--json']),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.match(JSON.parse(error.stderr).error.message, /same credential/);
        return true;
      },
    );
  assert.ok(f.requests.every((request) => request.method === 'GET'));
  await f.assertNoExecutions();
});

test('a human owner cannot start work claimed by their agent', async (t) => {
  const f = await fixture(t, {
    task: {
      ...initialTask,
      status: 'claimed',
      ownerId: userId,
      ownerAgentId: agentId,
      assignedAgentId: agentId,
      repository,
    },
  });
  await assert.rejects(
    f.call(['task', 'start', taskId, '--path', join(f.directory, 'worktree'), '--json']),
    (error) => {
      assert.match(JSON.parse(error.stderr).error.message, /same credential/);
      return true;
    },
  );
  await f.assertNoExecutions();
});

test('merge rejects a non-leader before invoking GitHub or changing task state', async (t) => {
  for (const actor of [
    { id: userId, email: 'member@example.com' },
    { id: userId, email: 'member@example.com', agentId: otherAgentId, clanId },
  ]) {
    const f = await fixture(t, { actor, task: { ...initialTask, status: 'claimed', ownerId: userId, repository } });
    await assert.rejects(f.call(['task', 'merge', taskId, '--json']), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(JSON.parse(error.stderr).error.message, /Only the clan leader/);
      return true;
    });
    assert.ok(f.requests.every((request) => request.method === 'GET'));
    assert.ok(!f.requests.some((request) => request.path.includes('/tasks/')));
    await f.assertNoExecutions();
  }
});

test('whoami keeps human identity and includes agent registration for agent credentials', async (t) => {
  const human = { id: userId, email: 'member@example.com' };
  const personal = await fixture(t, { actor: human });
  assert.deepEqual(JSON.parse((await personal.call(['whoami', '--json'])).stdout), human);
  assert.deepEqual(
    personal.requests.map((request) => request.path),
    ['/v1/me'],
  );
  const actor = { ...human, agentId, clanId };
  const scoped = await fixture(t, { actor });
  const identity = JSON.parse((await scoped.call(['whoami', '--json'])).stdout);
  assert.deepEqual(identity, {
    ...actor,
    agent: { id: agentId, ownerId: userId, clanId, name: 'Worker', role: 'worker', createdAt: initialTask.createdAt },
  });
  const output = (await scoped.call(['whoami'])).stdout;
  for (const value of ['Worker', agentId, 'role=worker', `clan=${clanId}`, `owner=${userId}`, human.email]) {
    assert.ok(output.includes(value));
  }
  assert.deepEqual(
    scoped.requests.map((request) => request.path),
    ['/v1/me', '/v1/agent', '/v1/me', '/v1/agent'],
  );
});
