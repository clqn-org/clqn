import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ClqnClient, ApiError } from '@clqn/shared';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));

async function fixture(t, status, body) {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
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
  await assert.rejects(run(process.execPath, [cli, '--json', '--api-url', url, 'health']), (error) => {
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

async function workspaceFixture(t) {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'clqn-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const user = { id: 'e6bc7a0a-7291-435a-a7fc-a9d544233270', email: 'alice@example.com' };
  const clan = { id: '75e888b7-d3f1-4cbc-a5ba-2b9b9c7bfc69', name: 'My project', createdBy: user.id, createdAt: '2026-11-14T12:00:00.000Z' };
  const members = { members: [{ userId: user.id, email: user.email, role: 'leader', createdAt: clan.createdAt }] };
  const invitation = { code: `clqn_inv_${'a'.repeat(43)}`, clanId: clan.id, email: 'bob@example.com', expiresAt: '2026-11-21T12:00:00.000Z' };
  const requests = [];
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
    else if (request.url === '/v1/clans' && request.method === 'POST') {
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
    else { response.writeHead(404); response.end('{}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  // Leave CLQN_TOKEN absent by default so persisted credentials are exercised.
  const call = (args, options = {}) => {
    const environment = { ...process.env, CLQN_CONFIG_DIR: directory, ...options.env };
    if (!options.env || !Object.hasOwn(options.env, 'CLQN_TOKEN')) delete environment.CLQN_TOKEN;
    const result = run(process.execPath, [cli, '--api-url', url, ...args], { env: environment });
    result.child.stdin.end(options.input);
    return result;
  };
  return { call, directory, user, clan, members, invitation, token, requests, url };
}

test('CLI invitations normalize email, support an explicit clan, and joining selects the clan', async (t) => {
  const f = await workspaceFixture(t);
  await f.call(['login'], { input: f.token });
  assert.deepEqual(JSON.parse((await f.call(['invite', ' Bob@Example.com ', '--clan', f.clan.id, '--json'])).stdout), f.invitation);
  assert.deepEqual(JSON.parse((await f.call(['join', f.invitation.code, '--json'])).stdout), f.clan);
  assert.deepEqual(JSON.parse((await f.call(['members', '--json'])).stdout), f.members);
  assert.deepEqual(JSON.parse((await f.call(['invite', f.invitation.email, '--json'])).stdout), f.invitation);
});

test('CLI rejects malformed invitation input before making an HTTP request', async (t) => {
  const f = await workspaceFixture(t);
  for (const args of [['invite', 'bob@example.com'], ['invite', 'invalid-email', '--clan', f.clan.id], ['join', 'invalid-code']]) {
    await assert.rejects(f.call([...args, '--json']), (error) => {
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
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.directory, filename))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(f.directory, filename), 'utf8')).token, f.token);
  assert.deepEqual(JSON.parse((await f.call(['whoami', '--json'])).stdout), f.user);
  assert.deepEqual(JSON.parse((await f.call(['--api-url', `${f.url}/ignored/base`, 'whoami', '--json'])).stdout), f.user);
  assert.match((await f.call(['whoami'])).stdout, /alice@example.com/);
  assert.deepEqual(JSON.parse((await f.call(['init', f.clan.name, '--json'])).stdout), f.clan);
  assert.deepEqual(JSON.parse((await f.call(['clans', '--json'])).stdout), { clans: [f.clan] });
  assert.deepEqual(JSON.parse((await f.call(['members', '--json'])).stdout), f.members);
  assert.deepEqual(JSON.parse((await f.call(['members', '--clan', f.clan.id, '--json'])).stdout), f.members);
  assert.match((await f.call(['members'])).stdout, /alice@example.com  leader/);
  const logout = JSON.parse((await f.call(['logout', '--json'])).stdout);
  assert.deepEqual(logout, { credentialsRemoved: true, environmentTokenActive: false });
  assert.deepEqual(await readdir(f.directory), []);
  await assert.rejects(f.call(['whoami', '--json']), (error) => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stderr).error.code, 'UNAUTHENTICATED');
    return true;
  });
});

test('failed login preserves credentials, environment override works, and another API receives no saved token', async (t) => {
  const f = await workspaceFixture(t);
  await f.call(['login'], { input: f.token });
  await assert.rejects(f.call(['login', '--json'], { input: 'invalid_token' }), (error) => {
    assert.equal(JSON.parse(error.stderr).error.code, 'UNAUTHENTICATED');
    assert.ok(!error.stderr.includes('invalid_token'));
    return true;
  });
  await f.call(['whoami']);
  assert.equal(f.requests.at(-1).authorization, `Bearer ${f.token}`);
  await f.call(['whoami'], { env: { CLQN_TOKEN: 'env_token' } });
  assert.equal(f.requests.at(-1).authorization, 'Bearer env_token');
  const other = await workspaceFixture(t);
  const otherEnvironment = { ...process.env, CLQN_CONFIG_DIR: f.directory };
  delete otherEnvironment.CLQN_TOKEN;
  await assert.rejects(run(process.execPath, [cli, '--api-url', other.url, 'whoami', '--json'], {
    env: otherEnvironment,
  }));
  assert.equal(other.requests.at(-1).authorization, undefined);
  const result = await f.call(['logout', '--json'], { env: { CLQN_TOKEN: 'env_token' } });
  assert.equal(JSON.parse(result.stdout).environmentTokenActive, true);
});

test('login requires token input and members requires a selected clan', async (t) => {
  const f = await workspaceFixture(t);
  for (const args of [['login'], ['members']]) {
    await assert.rejects(f.call([...args, '--json']), (error) => {
      assert.equal(JSON.parse(error.stderr).error.code, 'COMMAND_FAILED');
      return true;
    });
  }
  assert.equal(f.requests.length, 0);
});
