import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { readConfig } from '../src/config.js';

test('GitHub CLI saves only clqn token, prints identity without credentials, uses POST polling', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'clqn-github-'));
  const token = `clqn_${'a'.repeat(43)}`;
  const user = { id: randomUUID(), email: 'verified@example.com' };
  const server = createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type', 'application/json');
    if (req.url === '/auth/github/start')
      res.end(
        JSON.stringify({
          handle: 'h'.repeat(43),
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://github.com/login/device',
          expiresIn: 15,
          interval: 5,
        }),
      );
    else {
      assert.equal(req.url, '/auth/github/poll');
      assert.equal(body.handle, 'h'.repeat(43));
      res.end(JSON.stringify({ status: 'complete', user, token }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const result = await promisify(execFile)(
    process.execPath,
    ['packages/cli/dist/index.js', '--api-url', url, '--json', 'login', '--github'],
    {
      env: { ...process.env, CLQN_CONFIG_DIR: dir, CLQN_TOKEN: '' },
      timeout: 15000,
    },
  );
  assert.deepEqual(JSON.parse(result.stdout), user);
  assert.match(result.stderr, /ABCD-EFGH/);
  assert.equal((result.stdout + result.stderr).includes(token), false);
  const previous = process.env.CLQN_CONFIG_DIR;
  process.env.CLQN_CONFIG_DIR = dir;
  try {
    assert.equal((await readConfig(url)).token, token);
  } finally {
    if (previous === undefined) delete process.env.CLQN_CONFIG_DIR;
    else process.env.CLQN_CONFIG_DIR = previous;
  }
});

test('GitHub CLI login retries a temporary poll failure until the code expires', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'clqn-github-'));
  const token = `clqn_${'b'.repeat(43)}`;
  const user = { id: randomUUID(), email: 'verified@example.com' };
  let polls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/auth/github/start')
      res.end(
        JSON.stringify({
          handle: 'h'.repeat(43),
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://github.com/login/device',
          expiresIn: 30,
          interval: 5,
        }),
      );
    else if (++polls === 1) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: { code: 'GITHUB_LOGIN_FAILED', message: 'GitHub login failed; try again' } }));
    } else res.end(JSON.stringify({ status: 'complete', user, token }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const result = await promisify(execFile)(
    process.execPath,
    ['packages/cli/dist/index.js', '--api-url', url, '--json', 'login', '--github'],
    {
      env: { ...process.env, CLQN_CONFIG_DIR: dir, CLQN_TOKEN: '' },
      timeout: 30000,
    },
  );
  assert.deepEqual(JSON.parse(result.stdout), user);
  assert.equal(polls, 2);
});
