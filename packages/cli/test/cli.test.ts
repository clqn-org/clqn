import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sourceNodeArgs } from '../../../scripts/test-node.js';
import { writeConfig } from '../src/config.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../src/index.ts', import.meta.url));

// execFile rejects with the exit code and captured output.
type ExecError = Error & { code: number; stdout: string; stderr: string };

async function fixture(t: TestContext, status: number, body: unknown) {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('CLI emits parseable JSON from an HTTP response', async (t) => {
  const body = { status: 'ok', service: 'clqn-api', version: '0.1.0' };
  const url = await fixture(t, 200, body);
  const { stdout, stderr } = await run(process.execPath, [
    ...sourceNodeArgs,
    cli,
    'health',
    '--json',
    '--api-url',
    url,
  ]);
  assert.deepEqual(JSON.parse(stdout), body);
  assert.equal(stderr, '');
});

test('CLI returns nonzero and structured errors when the API fails', async (t) => {
  const body = { error: { code: 'UNAVAILABLE', message: 'Try again later' } };
  const url = await fixture(t, 503, body);
  await assert.rejects(
    run(process.execPath, [...sourceNodeArgs, cli, '--json', '--api-url', url, 'health']),
    (thrown) => {
      const error = thrown as ExecError;
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.deepEqual(JSON.parse(error.stderr), body);
      return true;
    },
  );
});

async function workspaceFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'clqn-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const user = { id: 'e6bc7a0a-7291-435a-a7fc-a9d544233270', email: 'alice@example.com' };
  const clan = {
    id: '75e888b7-d3f1-4cbc-a5ba-2b9b9c7bfc69',
    name: 'My project',
    createdBy: user.id,
    createdAt: '2026-11-14T12:00:00.000Z',
  };
  const members = { members: [{ userId: user.id, email: user.email, role: 'leader', createdAt: clan.createdAt }] };
  const invitation = {
    code: `clqn_inv_${'a'.repeat(43)}`,
    clanId: clan.id,
    email: 'bob@example.com',
    expiresAt: '2026-11-21T12:00:00.000Z',
  };
  const pending = [{ clanId: clan.id, clanName: clan.name, expiresAt: invitation.expiresAt }];
  const requests: { path: string | undefined; authorization: string | undefined }[] = [];
  const token = 'clqn_example_secret';
  const server = createServer(async (request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}` && request.headers.authorization !== 'Bearer env_token') {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }));
      return;
    }
    if (request.url === '/v1/me') response.end(JSON.stringify(user));
    else if (request.url === '/v1/logout' && request.method === 'POST') response.end(JSON.stringify({ revoked: true }));
    else if (request.url === `/v1/clans/${clan.id}/members/${user.id}/remove` && request.method === 'POST')
      response.end(JSON.stringify({ removed: true }));
    else if (request.url === `/v1/clans/${clan.id}/leave` && request.method === 'POST')
      response.end(JSON.stringify({ left: true }));
    else if (request.url === `/v1/clans/${clan.id}/delete` && request.method === 'POST')
      response.end(JSON.stringify({ deleted: true, repositories: [] }));
    else if (request.url === `/v1/clans/${clan.id}/leader` && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      response.end(JSON.stringify({ leaderId: JSON.parse(body).userId }));
    } else if (request.url === '/v1/clans' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { name: clan.name });
      response.writeHead(201);
      response.end(JSON.stringify(clan));
    } else if (request.url === `/v1/clans/${clan.id}/invitations` && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { email: invitation.email });
      response.writeHead(201);
      response.end(JSON.stringify(invitation));
    } else if (request.url === '/v1/invitations') response.end(JSON.stringify({ invitations: pending }));
    else if (request.url === '/v1/invitations/accept' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { clanId: clan.id });
      response.end(JSON.stringify(clan));
    } else if (request.url === '/v1/invitations/join' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { code: invitation.code });
      response.end(JSON.stringify(clan));
    } else if (request.url === '/v1/clans') response.end(JSON.stringify({ clans: [clan] }));
    else if (request.url === `/v1/clans/${clan.id}/members`) response.end(JSON.stringify(members));
    else if (request.url === `/v1/clans/${clan.id}/agents`) {
      const agent = { id: clan.id, clanId: clan.id, ownerId: user.id, createdAt: clan.createdAt, role: 'worker' };
      const agents = [
        { ...agent, name: 'Codex', alias: 'codex', active: true },
        { ...agent, id: user.id, name: 'Claude', alias: 'claude', active: false },
      ];
      response.end(JSON.stringify({ agents }));
    } else {
      response.writeHead(404);
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Leave CLQN_TOKEN absent by default so persisted credentials are exercised.
  const call = (
    args: string[],
    options: { env?: Record<string, string>; input?: string; useSavedServer?: boolean } = {},
  ) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, CLQN_CONFIG_DIR: directory, ...options.env };
    if (!options.env || !Object.hasOwn(options.env, 'CLQN_TOKEN')) delete environment.CLQN_TOKEN;
    if (!options.env || !Object.hasOwn(options.env, 'CLQN_API_URL')) delete environment.CLQN_API_URL;
    const server = options.useSavedServer ? [] : ['--api-url', url];
    const result = run(process.execPath, [...sourceNodeArgs, cli, ...server, ...args], { env: environment });
    result.child.stdin?.end(options.input);
    return result;
  };
  // Save a credential the way GitHub sign-in in the interactive clqn command does.
  const signIn = async () => {
    const previous = process.env.CLQN_CONFIG_DIR;
    process.env.CLQN_CONFIG_DIR = directory;
    try {
      await writeConfig(url, { token });
    } finally {
      if (previous === undefined) delete process.env.CLQN_CONFIG_DIR;
      else process.env.CLQN_CONFIG_DIR = previous;
    }
  };
  return { call, signIn, directory, user, clan, members, invitation, pending, token, requests, url };
}

test('CLI marks revoked agents in the agent list', async (t) => {
  const f = await workspaceFixture(t);
  await f.signIn();
  const lines = (await f.call(['agent', 'list', '--clan', f.clan.id])).stdout.trim().split('\n');
  assert.ok(!lines[0]?.endsWith('revoked'));
  assert.ok(lines[1]?.endsWith('  revoked'));
});

test('CLI invitations normalize email and support an explicit clan', async (t) => {
  const f = await workspaceFixture(t);
  await f.signIn();
  const { code, ...invitation } = f.invitation;
  assert.deepEqual(
    JSON.parse((await f.call(['invite', ' Bob@Example.com ', '--clan', f.clan.id, '--json'])).stdout),
    invitation,
  );
  const human = (await f.call(['invite', f.invitation.email, '--clan', f.clan.id])).stdout;
  assert.doesNotMatch(human, /clqn_inv_/);
  assert.match(human, /run clqn and choose View clan invites/);
  assert.deepEqual(
    JSON.parse((await f.call(['invite', f.invitation.email, '--clan', f.clan.id, '--code', '--json'])).stdout),
    { code, ...invitation },
  );
});

test('CLI removes members and transfers leadership by email, and leaving clears the selected clan', async (t) => {
  const f = await workspaceFixture(t);
  await f.signIn();
  await f.call(['use', f.clan.name]);
  const removed = await f.call(['members', 'remove', 'Alice@Example.com', '--clan', f.clan.id, '--json']);
  assert.deepEqual(JSON.parse(removed.stdout), { removed: true });
  assert.equal(f.requests.at(-1)?.path, `/v1/clans/${f.clan.id}/members/${f.user.id}/remove`);
  await assert.rejects(f.call(['members', 'remove', 'nobody@example.com', '--json']));
  const transferred = await f.call(['members', 'transfer', 'alice@example.com', '--clan', f.clan.id, '--json']);
  assert.deepEqual(JSON.parse(transferred.stdout), { leaderId: f.user.id });
  assert.deepEqual(JSON.parse((await f.call(['leave', '--json'])).stdout), { left: true });
  await assert.rejects(f.call(['members', '--json']), (thrown) => {
    assert.equal(JSON.parse((thrown as ExecError).stderr).error.code, 'COMMAND_FAILED');
    return true;
  });
});

test('CLI deletes a clan by name and clears the selected clan', async (t) => {
  const f = await workspaceFixture(t);
  await f.signIn();
  await f.call(['use', f.clan.name]);
  await assert.rejects(f.call(['delete', 'Other clan', '--json']));
  const deleted = await f.call(['delete', f.clan.name.toUpperCase(), '--json']);
  assert.deepEqual(JSON.parse(deleted.stdout), { deleted: true, repositories: [], webhooksLeft: [] });
  assert.equal(f.requests.at(-1)?.path, `/v1/clans/${f.clan.id}/delete`);
  await assert.rejects(f.call(['members', '--json']), (thrown) => {
    assert.equal(JSON.parse((thrown as ExecError).stderr).error.code, 'COMMAND_FAILED');
    return true;
  });
});

test('commands without a selected clan or with a malformed email fail before any HTTP request', async (t) => {
  const f = await workspaceFixture(t);
  for (const args of [['members'], ['invite', 'bob@example.com'], ['invite', 'invalid-email', '--clan', f.clan.id]]) {
    await assert.rejects(f.call([...args, '--json']), (thrown) => {
      const error = thrown as ExecError;
      assert.equal(JSON.parse(error.stderr).error.code, 'COMMAND_FAILED');
      return true;
    });
  }
  assert.equal(f.requests.length, 0);
});

test('CLI saved credentials and clan selection are API-scoped private configuration', async (t) => {
  const f = await workspaceFixture(t);
  await f.signIn();
  const filename = (await readdir(f.directory)).find((name) => name.endsWith('.json'));
  assert.ok(filename);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.directory, filename))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(f.directory, filename), 'utf8')).token, f.token);
  assert.deepEqual(JSON.parse((await f.call(['whoami', '--json'])).stdout), f.user);
  assert.deepEqual(
    JSON.parse((await f.call(['--api-url', `${f.url}/ignored/base`, 'whoami', '--json'])).stdout),
    f.user,
  );
  assert.match((await f.call(['whoami'])).stdout, /alice@example.com/);
  assert.deepEqual(JSON.parse((await f.call(['clans', '--json'])).stdout), { clans: [f.clan] });
  assert.equal((await f.call(['use', 'my project'])).stdout, 'Using My project.\n');
  assert.equal((await f.call(['clans'])).stdout, 'My project (current)\n');
  assert.deepEqual(JSON.parse((await f.call(['members', '--json'])).stdout), f.members);
  assert.deepEqual(JSON.parse((await f.call(['members', '--clan', f.clan.id, '--json'])).stdout), f.members);
  assert.match((await f.call(['members'])).stdout, /alice@example.com  leader/);
  // A saved clan selection needs no identity lookup before the command's own request.
  const before = f.requests.length;
  await f.call(['members', '--json']);
  assert.deepEqual(
    f.requests.slice(before).map((request) => request.path),
    [`/v1/clans/${f.clan.id}/members`],
  );
});

test('environment token override works and another API receives no saved token', async (t) => {
  const f = await workspaceFixture(t);
  await f.signIn();
  await f.call(['whoami']);
  assert.equal(f.requests.at(-1)?.authorization, `Bearer ${f.token}`);
  await f.call(['whoami'], { env: { CLQN_TOKEN: 'env_token' } });
  assert.equal(f.requests.at(-1)?.authorization, 'Bearer env_token');
  const other = await workspaceFixture(t);
  const otherEnvironment: NodeJS.ProcessEnv = { ...process.env, CLQN_CONFIG_DIR: f.directory };
  delete otherEnvironment.CLQN_TOKEN;
  await assert.rejects(
    run(process.execPath, [...sourceNodeArgs, cli, '--api-url', other.url, 'whoami', '--json'], {
      env: otherEnvironment,
    }),
  );
  assert.equal(other.requests.at(-1)?.authorization, undefined);
});

test('commands use the saved server unless an override is given', async (t) => {
  const f = await workspaceFixture(t);
  await f.signIn();
  await writeFile(join(f.directory, 'server'), `${f.url}\n`, { mode: 0o600 });
  const clans = await f.call(['clans', '--json'], { useSavedServer: true });
  assert.deepEqual(JSON.parse(clans.stdout), { clans: [f.clan] });
  const other = await workspaceFixture(t);
  await assert.rejects(f.call(['whoami', '--json'], { useSavedServer: true, env: { CLQN_API_URL: other.url } }));
  assert.equal(other.requests.at(-1)?.authorization, undefined);
  const who = await f.call(['whoami', '--json'], { useSavedServer: true });
  assert.deepEqual(JSON.parse(who.stdout), f.user);
});
