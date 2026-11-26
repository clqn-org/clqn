import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sourceNodeArgs } from '../../../scripts/test-node.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const clanId = '84367b51-14c7-43de-84a1-faf0207eadb3';
const userId = 'd724b185-7509-4bc1-adf6-eb7978f96a1a';
const otherMemberId = '0bb76703-1534-4f38-bfe4-ef38bfea3875';
const agentId = '9608d1b9-bcaf-4f20-adab-10305cf5474f';
const taskId = 'feeb7372-1243-423f-9f3c-9ed8d5a24b57';
const createdAt = '2026-11-14T12:00:00.000Z';

// execFile rejects with the exit code and captured output.
type ExecError = Error & { code: number; stdout: string; stderr: string };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'clqn-simple-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = `clqn_${'s'.repeat(43)}`;
  const user = { id: userId, email: 'member@example.com' };
  const agentToken = `clqn_${'a'.repeat(43)}`;
  const agentActor = { ...user, agentId, clanId };
  let registered: { id: string; name: string; role: string; alias?: string } | undefined;
  let backups: string[] = [];
  const requests: {
    method: string | undefined;
    path: string | undefined;
    authorization: string | undefined;
    body: unknown;
  }[] = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization === `Bearer ${agentToken}` && request.url === '/v1/me') {
      response.end(JSON.stringify(agentActor));
    } else if (request.headers.authorization === `Bearer ${agentToken}` && request.url === '/v1/agent') {
      response.end(JSON.stringify(registered));
    } else if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Token required' } }));
    } else if (request.url === '/v1/me') response.end(JSON.stringify(user));
    else if (request.url === `/v1/clans/${clanId}/agents` && request.method === 'POST') {
      response.writeHead(201);
      registered = { id: agentId, ownerId: userId, clanId, createdAt, ...body };
      response.end(JSON.stringify({ agent: registered, token: agentToken }));
    } else if (request.url === `/v1/clans/${clanId}/agents`) {
      response.end(JSON.stringify({ agents: registered ? [registered] : [] }));
    } else if (request.url === `/v1/clans/${clanId}/members`) {
      response.end(
        JSON.stringify({
          members: [
            { userId, email: user.email, role: 'member', createdAt },
            { userId: otherMemberId, email: 'second@example.com', role: 'member', createdAt },
          ],
        }),
      );
    } else if (request.url === `/v1/clans/${clanId}/chat/host/backups`) {
      if (request.method === 'POST') backups = body.userIds;
      response.end(JSON.stringify({ userIds: backups }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Unknown route' } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const executions = join(directory, 'executions');
  for (const executable of ['git', 'gh'])
    await writeFile(join(bin, executable), '#!/bin/sh\necho invoked >> "$CLQN_TEST_EXECUTIONS"\nexit 91\n', {
      mode: 0o700,
    });
  const call = (args: string[], options: { profile?: string; token?: string } = {}) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLQN_CONFIG_DIR: join(directory, 'config'),
      CLQN_TOKEN: options.token ?? token,
      CLQN_CLAN_ID: clanId,
      PATH: `${bin}:${process.env.PATH}`,
      CLQN_TEST_EXECUTIONS: executions,
    };
    if (options.profile) env.CLQN_AGENT_PROFILE = options.profile;
    else delete env.CLQN_AGENT_PROFILE;
    return run(process.execPath, [...sourceNodeArgs, cli, '--api-url', apiUrl, ...args], { env, cwd: directory });
  };
  const renameAgent = (name: string) => {
    if (registered) registered.name = name;
  };
  return { call, requests, directory, bin, token, agentToken, user, executions, renameAgent };
}

test('human output strips terminal control characters from API text, while JSON keeps it exact', async (t) => {
  const f = await fixture(t);
  await f.call(['agent', 'add', 'worker', '--json']);
  const name = 'Fix\x1b]0;spoofed\x07 bug\x1b[2J\r\nnext';
  f.renameAgent(name);
  const human = (await f.call(['agent', 'list'])).stdout;
  assert.doesNotMatch(human, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  assert.match(human, /Fix ]0;spoofed  bug \[2J \nnext/);
  assert.equal(JSON.parse((await f.call(['agent', 'list', '--json'])).stdout).agents[0].name, name);
});

test('agent add registers workers and orchestrators with positional names', async (t) => {
  const f = await fixture(t);
  const worker = JSON.parse((await f.call(['agent', 'add', 'Codex', '--json'])).stdout);
  const orchestrator = JSON.parse((await f.call(['agent', 'add', 'Coordinator', '--orchestrator', '--json'])).stdout);
  assert.equal(worker.agent.name, 'Codex');
  assert.equal(orchestrator.agent.role, 'orchestrator');
  assert.deepEqual(
    f.requests.map((request) => request.body),
    [
      { name: 'Codex', role: 'worker' },
      { name: 'Coordinator', role: 'orchestrator' },
    ],
  );
});

test('whoami shows the person, or for agent credentials the agent and its owner', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(JSON.parse((await f.call(['whoami', '--json'])).stdout), f.user);
  await f.call(['agent', 'add', 'Worker', '--json']);
  const before = f.requests.length;
  const identity = JSON.parse((await f.call(['whoami', '--json'], { token: f.agentToken })).stdout);
  assert.deepEqual(identity, {
    ...f.user,
    agentId,
    clanId,
    agent: { id: agentId, ownerId: userId, clanId, createdAt, name: 'Worker', role: 'worker' },
  });
  assert.equal(
    (await f.call(['whoami'], { token: f.agentToken })).stdout,
    `Worker (worker)\nSigned in for ${f.user.email}\n`,
  );
  assert.deepEqual(
    f.requests.slice(before).map((request) => request.path),
    ['/v1/me', '/v1/agent', '/v1/me', '/v1/agent'],
  );
});

test('agent setup saves a private profile that scopes later commands to the agent', async (t) => {
  const f = await fixture(t);
  const added = await f.call(['agent', 'add', 'coordinator', '--orchestrator', '--runtime', 'codex', '--json']);
  assert.deepEqual(JSON.parse(added.stdout), {
    agent: { name: 'coordinator', alias: 'coordinator', role: 'orchestrator' },
  });
  assert.doesNotMatch(added.stdout + added.stderr, /clqn_[A-Za-z0-9_-]{43}/);
  assert.doesNotMatch((await f.call(['agent', 'list'])).stdout, new RegExp(agentId));
  const [file] = await readdir(join(f.directory, 'config', 'agents'));
  const profile = join(f.directory, 'config', 'agents', file!);
  assert.ok(file?.endsWith(`-${agentId}.json`));
  assert.equal((await stat(profile)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(profile, 'utf8'));
  assert.equal(saved.token, f.agentToken);
  assert.equal(saved.runtime, 'codex');
  assert.match(
    (await f.call(['agent', 'add', 'helper'])).stdout,
    /runs the tasks you approve while you have clqn open/,
  );

  const identity = JSON.parse((await f.call(['whoami', '--json'], { profile })).stdout);
  assert.equal(identity.agentId, agentId);
  assert.equal(f.requests.at(-1)?.authorization, `Bearer ${f.agentToken}`);
  await assert.rejects(
    f.call(['whoami'], { profile: join(f.directory, 'missing') }),
    /saved agent connection is missing/,
  );
  await assert.rejects(f.call(['use', 'clan'], { profile }), /personal terminal/);
});

test('agent add exposes a credential only when explicitly requested for a custom runtime', async (t) => {
  const f = await fixture(t);
  const result = JSON.parse((await f.call(['agent', 'add', 'custom', '--show-token', '--json'])).stdout);
  assert.equal(result.agent.id, agentId);
  assert.equal(result.token, f.agentToken);
});

test('agent add rejects a blank name before HTTP access', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.call(['agent', 'add', ' ', '--json']), (thrown) => {
    const error = thrown as ExecError;
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.equal(JSON.parse(error.stderr).error.code, 'COMMAND_FAILED');
    return true;
  });
  assert.equal(f.requests.length, 0);
});

test('unknown commands and flags fail before API or Git access', async (t) => {
  const f = await fixture(t);
  for (const args of [['sync'], ['task', 'start', taskId], ['agent', 'add', '--name', 'Legacy']])
    await assert.rejects(f.call(args), (thrown) => {
      const error = thrown as ExecError;
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
  assert.doesNotMatch(main.stdout, /\bmcp\b|\bpolicy\b|\blimits\b/);
  assert.match((await f.call(['mcp', '--help'])).stdout, /Start the local stdio MCP server/);
  assert.doesNotMatch((await f.call(['agent', '--help'])).stdout, /^\s+(status|connect|run)(?:\s|$)/m);
  assert.equal(f.requests.length, 0);
});

test('host lists, replaces, and clears multiple nominated backups', async (t) => {
  const f = await fixture(t);
  const nominated = await f.call(['host', f.user.email.toUpperCase(), otherMemberId, '--json']);
  assert.deepEqual(JSON.parse(nominated.stdout), { userIds: [userId, otherMemberId] });
  const listed = await f.call(['host']);
  assert.equal(listed.stdout.trim(), `${f.user.email}\nsecond@example.com`);
  const cleared = await f.call(['host', 'off', '--json']);
  assert.deepEqual(JSON.parse(cleared.stdout), { userIds: [] });
  const path = `/v1/clans/${clanId}/chat/host/backups`;
  assert.deepEqual(
    f.requests.filter((entry) => entry.path === path).map(({ method, body }) => [method, body]),
    [
      ['POST', { userIds: [userId, otherMemberId] }],
      ['GET', undefined],
      ['POST', { userIds: [] }],
    ],
  );
  await assert.rejects(f.call(['host', 'off', f.user.email]), /Use off by itself/);
  await assert.rejects(f.call(['host', f.user.email, 'outside@example.com']), /Member not found/);
});
