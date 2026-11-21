import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const clanId = '28c42b15-9a81-480d-9ff5-596a2e9e7428';
const userId = 'dbab0ddd-41bd-42ba-83c7-d48078552cc7';

async function fixture(t, { conflict = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'clqn-policy-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = `clqn_${'p'.repeat(43)}`;
  let policy = {
    clanId,
    userId,
    tokenLimit: null,
    allowedModels: null,
    control: 'manual',
    revision: 7,
    enforcement: 'unavailable',
  };
  const requests = [];
  const server = createServer(async (request, response) => {
    let rawBody = '';
    for await (const chunk of request) rawBody += chunk;
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }));
    } else if (request.url !== `/v1/clans/${clanId}/policy`) {
      response.writeHead(404);
      response.end('{}');
    } else if (request.method === 'GET') response.end(JSON.stringify(policy));
    else if (conflict) {
      response.writeHead(409);
      response.end(
        JSON.stringify({
          error: { code: 'REVISION_CONFLICT', message: 'Policy changed; read the latest revision before updating' },
        }),
      );
    } else {
      const { expectedRevision, ...changes } = body;
      policy = { ...policy, ...changes, revision: expectedRevision + 1 };
      response.end(JSON.stringify(policy));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (args, overrides = {}) => {
    // Never read the caller's saved login or inherit their active clan/token.
    const env = { ...process.env, CLQN_CONFIG_DIR: directory, CLQN_TOKEN: token, CLQN_CLAN_ID: clanId, ...overrides };
    return run(process.execPath, [cli, '--api-url', url, ...args], { env });
  };
  return { call, requests, token, initial: { ...policy } };
}

test('limits returns JSON and states the lack of runtime enforcement in human output', async (t) => {
  const f = await fixture(t);
  const result = await f.call(['limits', '--json']);
  assert.deepEqual(JSON.parse(result.stdout), f.initial);
  assert.equal(result.stderr, '');
  assert.equal(f.requests[0].authorization, `Bearer ${f.token}`);
  const human = await f.call(['limits', '--clan', clanId], { CLQN_CLAN_ID: userId });
  assert.match(human.stdout, /Token limit: none/);
  assert.match(human.stdout, /Allowed models: any/);
  assert.match(human.stdout, /Leader control: manual/);
  assert.match(human.stdout, /Runtime enforcement is unavailable/);
  assert.match(human.stdout, /does not grant execution access/);
  assert.ok(f.requests.every((request) => request.path === `/v1/clans/${clanId}/policy`));
});

test('limits sends the selected settings and latest revision without replacing unspecified settings', async (t) => {
  const f = await fixture(t);
  const result = await f.call([
    'limits',
    '--tokens',
    '50000',
    '--models',
    'provider/model-a',
    'provider/model-b',
    '--control',
    'approve',
    '--json',
  ]);
  assert.deepEqual(
    f.requests.map((request) => request.method),
    ['GET', 'POST'],
  );
  assert.deepEqual(f.requests[1].body, {
    tokenLimit: 50000,
    allowedModels: ['provider/model-a', 'provider/model-b'],
    control: 'approve',
    expectedRevision: 7,
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    ...f.initial,
    tokenLimit: 50000,
    allowedModels: ['provider/model-a', 'provider/model-b'],
    control: 'approve',
    revision: 8,
  });
});

test('limits supports zero budget, unrestricted models, and removal of a token cap', async (t) => {
  const f = await fixture(t);
  const zero = JSON.parse((await f.call(['limits', '--tokens', '0', '--control', 'automatic', '--json'])).stdout);
  assert.equal(zero.tokenLimit, 0);
  assert.equal(zero.control, 'automatic');
  await f.call(['limits', '--tokens', 'none', '--models', 'any', '--json']);
  assert.deepEqual(f.requests.at(-1).body, { tokenLimit: null, allowedModels: null, expectedRevision: 8 });
});

test('limits rejects malformed limits, model lists, control levels before HTTP access', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['--tokens', '-1'],
    ['--tokens', '1.5'],
    ['--tokens', '1e6'],
    ['--tokens', '9007199254740992'],
    ['--tokens', 'NaN'],
    ['--models', 'same', 'same'],
    ['--models', 'model with spaces'],
    ['--control', 'full'],
  ]) {
    await assert.rejects(f.call(['limits', ...args, '--json']), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.equal(JSON.parse(error.stderr).error.code, 'COMMAND_FAILED');
      return true;
    });
  }
  assert.equal(f.requests.length, 0);
});

test('limits surfaces revision conflicts without retrying or reporting success', async (t) => {
  const f = await fixture(t, { conflict: true });
  await assert.rejects(f.call(['limits', '--control', 'manual', '--json']), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.equal(JSON.parse(error.stderr).error.code, 'REVISION_CONFLICT');
    return true;
  });
  assert.deepEqual(
    f.requests.map((request) => request.method),
    ['GET', 'POST'],
  );
});
