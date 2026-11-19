import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const clanId = '84367b51-14c7-43de-84a1-faf0207eadb3';
const userId = 'd724b185-7509-4bc1-adf6-eb7978f96a1a';
const otherUserId = 'ab840359-0218-4c43-aa5b-3da942cc566d';
const agentId = '9608d1b9-bcaf-4f20-adab-10305cf5474f';
const taskId = 'feeb7372-1243-423f-9f3c-9ed8d5a24b57';
const createdAt = '2026-11-14T12:00:00.000Z';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'clqn-simple-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = `clqn_${'s'.repeat(43)}`;
  const user = { id: userId, email: 'member@example.com' };
  const task = { id: taskId, clanId, description: 'Assigned work', status: 'claimed', ownerId: otherUserId,
    ownerAgentId: null, assignedAgentId: null, repository: { slug: 'example/project', baseBranch: 'main',
      baseSha: 'a'.repeat(40), branch: 'clqn/simple-task', headSha: null, prNumber: null, prUrl: null,
      mergeCommitSha: null, state: 'pending' }, createdAt, updatedAt: createdAt };
  let policy = { clanId, userId, tokenLimit: null, allowedModels: null, control: 'manual', revision: 3, enforcement: 'unavailable' };
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401); response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Token required' } }));
    } else if (request.url === '/v1/me') response.end(JSON.stringify(user));
    else if (request.url === `/v1/clans/${clanId}/agents` && request.method === 'POST') {
      response.writeHead(201);
      response.end(JSON.stringify({ agent: { id: agentId, ownerId: userId, clanId, name: body.name,
        role: body.role, createdAt }, token }));
    } else if (request.url === `/v1/clans/${clanId}/policy`) {
      if (request.method === 'POST') {
        const { expectedRevision, ...changes } = body;
        policy = { ...policy, ...changes, revision: expectedRevision + 1 };
      }
      response.end(JSON.stringify(policy));
    } else if (request.url === `/v1/clans/${clanId}/tasks/${taskId}`) response.end(JSON.stringify(task));
    else if (request.url === `/v1/clans/${clanId}/tasks/${taskId}/complete` && request.method === 'POST') {
      response.end(JSON.stringify({ ...task, status: 'completed', ownerId: userId }));
    } else {
      response.writeHead(404); response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Unknown route' } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const executions = join(directory, 'executions');
  for (const executable of ['git', 'gh']) await writeFile(join(bin, executable), '#!/bin/sh\necho invoked >> "$CLQN_TEST_EXECUTIONS"\nexit 91\n', { mode: 0o700 });
  const call = (args, options = {}) => {
    const env = { ...process.env, CLQN_CONFIG_DIR: join(directory, 'config'), CLQN_TOKEN: token,
      CLQN_CLAN_ID: clanId, PATH: `${bin}:${process.env.PATH}`, CLQN_TEST_EXECUTIONS: executions };
    if (options.savedLogin) delete env.CLQN_TOKEN;
    const result = run(process.execPath, [cli, '--api-url', apiUrl, ...args], { env, cwd: directory });
    result.child.stdin.end(options.input);
    return result;
  };
  return { call, requests, directory, token, user, executions };
}

test('agent add registers workers and orchestrators with positional names', async (t) => {
  const f = await fixture(t);
  const worker = JSON.parse((await f.call(['agent', 'add', 'Codex', '--json'])).stdout);
  const orchestrator = JSON.parse((await f.call(['agent', 'add', 'Coordinator', '--orchestrator', '--json'])).stdout);
  assert.equal(worker.agent.name, 'Codex');
  assert.equal(orchestrator.agent.role, 'orchestrator');
  assert.deepEqual(f.requests.map((request) => request.body), [
    { name: 'Codex', role: 'worker' }, { name: 'Coordinator', role: 'orchestrator' },
  ]);
});

test('limits shows current settings or updates them directly', async (t) => {
  const f = await fixture(t);
  const initial = JSON.parse((await f.call(['limits', '--json'])).stdout);
  assert.equal(initial.revision, 3);
  assert.equal(initial.enforcement, 'unavailable');
  const updated = JSON.parse((await f.call(['limits', '--tokens', '100000', '--models', 'provider/model', '--control', 'approve', '--json'])).stdout);
  assert.equal(updated.tokenLimit, 100000);
  assert.equal(updated.revision, 4);
  assert.deepEqual(f.requests.map((request) => request.method), ['GET', 'GET', 'POST']);
  assert.deepEqual(f.requests[2].body, { tokenLimit: 100000, allowedModels: ['provider/model'], control: 'approve', expectedRevision: 3 });
});

test('simple commands reject invalid names and limit values before HTTP access', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['agent', 'add', ' '], ['limits', '--tokens', '-1'], ['limits', '--tokens', '1.5'],
    ['limits', '--tokens', 'NaN'], ['limits', '--models', 'same', 'same'], ['limits', '--control', 'full'],
  ]) await assert.rejects(f.call([...args, '--json']), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.equal(JSON.parse(error.stderr).error.code, 'COMMAND_FAILED');
    return true;
  });
  assert.equal(f.requests.length, 0);
});

test('task done uses the completion endpoint and JSON contract', async (t) => {
  const f = await fixture(t);
  const done = JSON.parse((await f.call(['task', 'done', taskId, '--json'])).stdout);
  assert.equal(done.status, 'completed');
  assert.ok(f.requests.every((request) => request.method === 'POST'
    && request.path === `/v1/clans/${clanId}/tasks/${taskId}/complete`));
  assert.deepEqual(f.requests.map((request) => request.body), [{}]);
});

test('task submit defaults to the current directory but preserves the ownership preflight', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.call(['task', 'submit', taskId, '--json']), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(JSON.parse(error.stderr).error.message, /same credential/);
    return true;
  });
  assert.ok(f.requests.every((request) => request.method === 'GET'));
  assert.equal(f.requests[0].path, `/v1/clans/${clanId}/tasks/${taskId}`);
  await assert.rejects(readFile(f.executions), { code: 'ENOENT' });
});

test('login accepts piped input', async (t) => {
  const f = await fixture(t);
  const login = JSON.parse((await f.call(['login', '--json'], { input: `${f.token}\n`, savedLogin: true })).stdout);
  assert.deepEqual(login, f.user);
  assert.ok(f.requests.every((request) => request.path === '/v1/me' && request.authorization === `Bearer ${f.token}`));
});

test('removed commands and flags fail before API or Git access', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['agent', 'status'], ['agent', 'connect', '--name', 'Legacy'], ['agent', 'add', '--name', 'Legacy'],
    ['sync'], ['watch'], ['repo', 'sync'], ['policy', 'show'], ['policy', 'set', '--tokens', '10'],
    ...['claim', 'prepare', 'publish', 'complete', 'integrate'].map((action) => ['task', action, taskId]),
    ...['metrics', 'metric', 'usage'].map((action) => [action]),
    ['login', '--token-stdin'], ['limits', '--token-limit', '10'],
  ]) await assert.rejects(f.call(args), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /unknown (command|option)/);
    return true;
  });
  assert.equal(f.requests.length, 0);
  await assert.rejects(readFile(f.executions), { code: 'ENOENT' });
});

test('main help hides mcp while explicit mcp help remains available', async (t) => {
  const f = await fixture(t);
  const main = await f.call(['--help']);
  assert.doesNotMatch(main.stdout, /\bmcp\b|\bpolicy\b/);
  assert.match((await f.call(['mcp', '--help'])).stdout, /Start the local stdio MCP server/);
  assert.doesNotMatch((await f.call(['agent', '--help'])).stdout, /status|connect/);
  assert.equal(f.requests.length, 0);
});
