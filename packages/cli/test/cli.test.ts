import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ApiError, ClqnClient } from '@clqn/shared';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));

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
  const { stdout, stderr } = await run(process.execPath, [cli, 'health', '--json', '--api-url', url]);
  assert.deepEqual(JSON.parse(stdout), body);
  assert.equal(stderr, '');
});

test('CLI returns nonzero and structured errors when the API fails', async (t) => {
  const body = { error: { code: 'UNAVAILABLE', message: 'Try again later' } };
  const url = await fixture(t, 503, body);
  await assert.rejects(run(process.execPath, [cli, '--json', '--api-url', url, 'health']), (thrown) => {
    const error = thrown as ExecError;
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.deepEqual(JSON.parse(error.stderr), body);
    return true;
  });
  await assert.rejects(new ClqnClient(url).health(), ApiError);
});

test('client rejects invalid server response contracts', async (t) => {
  const url = await fixture(t, 200, { status: 'pretend' });
  await assert.rejects(new ClqnClient(url).health());
});

async function workspaceFixture(t: TestContext) {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
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
  const call = (args: string[], options: { env?: Record<string, string>; input?: string } = {}) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, CLQN_CONFIG_DIR: directory, ...options.env };
    if (!options.env || !Object.hasOwn(options.env, 'CLQN_TOKEN')) delete environment.CLQN_TOKEN;
    const result = run(process.execPath, [cli, '--api-url', url, ...args], { env: environment });
    result.child.stdin?.end(options.input);
    return result;
  };
  return { call, directory, user, clan, members, invitation, token, requests, url };
}

test('CLI marks revoked agents in the agent list', async (t) => {
  const f = await workspaceFixture(t);
  await f.call(['login'], { input: f.token });
  const lines = (await f.call(['agent', 'list', '--clan', f.clan.id])).stdout.trim().split('\n');
  assert.ok(!lines[0]?.endsWith('revoked'));
  assert.ok(lines[1]?.endsWith('  revoked'));
});

test('CLI invitations normalize email, support an explicit clan, and joining selects the clan', async (t) => {
  const f = await workspaceFixture(t);
  await f.call(['login'], { input: f.token });
  assert.deepEqual(
    JSON.parse((await f.call(['invite', ' Bob@Example.com ', '--clan', f.clan.id, '--json'])).stdout),
    f.invitation,
  );
  assert.deepEqual(JSON.parse((await f.call(['join', f.invitation.code, '--json'])).stdout), f.clan);
  assert.deepEqual(JSON.parse((await f.call(['members', '--json'])).stdout), f.members);
  assert.deepEqual(JSON.parse((await f.call(['invite', f.invitation.email, '--json'])).stdout), f.invitation);
});

test('CLI removes members and transfers leadership by email, and leaving clears the selected clan', async (t) => {
  const f = await workspaceFixture(t);
  await f.call(['login'], { input: f.token });
  await f.call(['join', f.invitation.code]);
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

test('CLI rejects malformed invitation input before making an HTTP request', async (t) => {
  const f = await workspaceFixture(t);
  for (const args of [
    ['invite', 'bob@example.com'],
    ['invite', 'invalid-email', '--clan', f.clan.id],
    ['join', 'invalid-code'],
  ]) {
    await assert.rejects(f.call([...args, '--json']), (thrown) => {
      const error = thrown as ExecError;
      assert.equal(JSON.parse(error.stderr).error.code, 'COMMAND_FAILED');
      return true;
    });
  }
  assert.equal(f.requests.length, 0);
});

test('CLI login, clan creation, membership, and logout persist API-scoped private configuration', async (t) => {
  const { readdir, readFile, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const f = await workspaceFixture(t);
  const loggedIn = await f.call(['login', '--json'], { input: `${f.token}\n` });
  assert.deepEqual(JSON.parse(loggedIn.stdout), f.user);
  assert.equal(loggedIn.stderr, '');
  assert.ok(!loggedIn.stdout.includes(f.token));
  const [filename] = await readdir(f.directory);
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
  assert.deepEqual(JSON.parse((await f.call(['init', f.clan.name, '--json'])).stdout), f.clan);
  assert.deepEqual(JSON.parse((await f.call(['clans', '--json'])).stdout), { clans: [f.clan] });
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
  // Logging in again keeps the selected clan.
  await f.call(['login'], { input: f.token });
  assert.deepEqual(JSON.parse((await f.call(['members', '--json'])).stdout), f.members);
  const logout = JSON.parse((await f.call(['logout', '--json'])).stdout);
  assert.deepEqual(logout, { credentialsRemoved: true, tokenRevoked: true, environmentTokenActive: false });
  assert.deepEqual(f.requests.at(-1), { path: '/v1/logout', authorization: `Bearer ${f.token}` });
  assert.deepEqual(await readdir(f.directory), []);
  await assert.rejects(f.call(['whoami', '--json']), (thrown) => {
    const error = thrown as ExecError;
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stderr).error.code, 'UNAUTHENTICATED');
    return true;
  });
});

test('failed login preserves credentials, environment override works, and another API receives no saved token', async (t) => {
  const f = await workspaceFixture(t);
  await f.call(['login'], { input: f.token });
  await assert.rejects(f.call(['login', '--json'], { input: 'invalid_token' }), (thrown) => {
    const error = thrown as ExecError;
    assert.equal(JSON.parse(error.stderr).error.code, 'UNAUTHENTICATED');
    assert.ok(!error.stderr.includes('invalid_token'));
    return true;
  });
  await f.call(['whoami']);
  assert.equal(f.requests.at(-1)?.authorization, `Bearer ${f.token}`);
  await f.call(['whoami'], { env: { CLQN_TOKEN: 'env_token' } });
  assert.equal(f.requests.at(-1)?.authorization, 'Bearer env_token');
  const other = await workspaceFixture(t);
  const otherEnvironment: NodeJS.ProcessEnv = { ...process.env, CLQN_CONFIG_DIR: f.directory };
  delete otherEnvironment.CLQN_TOKEN;
  await assert.rejects(
    run(process.execPath, [cli, '--api-url', other.url, 'whoami', '--json'], {
      env: otherEnvironment,
    }),
  );
  assert.equal(other.requests.at(-1)?.authorization, undefined);
  const result = await f.call(['logout', '--json'], { env: { CLQN_TOKEN: 'env_token' } });
  assert.equal(JSON.parse(result.stdout).environmentTokenActive, true);
  // Only the saved token is revoked; an environment token is left alone.
  assert.equal(f.requests.at(-1)?.authorization, `Bearer ${f.token}`);
});

test('login requires token input and members requires a selected clan', async (t) => {
  const f = await workspaceFixture(t);
  for (const args of [['login'], ['members']]) {
    await assert.rejects(f.call([...args, '--json']), (thrown) => {
      const error = thrown as ExecError;
      assert.equal(JSON.parse(error.stderr).error.code, 'COMMAND_FAILED');
      return true;
    });
  }
  assert.equal(f.requests.length, 0);
});
