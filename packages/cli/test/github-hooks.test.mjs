import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configureGithubWebhook, removeGithubWebhook } from '../dist/github-hooks.js';

const repository = 'example/project';
const url = 'https://clqn.example/hooks/github/2c753d10-6378-4b86-963d-be68a816366c';
const secret = 'test-only-webhook-secret-'.repeat(3);

async function fixture(t, hooks = []) {
  const directory = await mkdtemp(join(tmpdir(), 'clqn-github-hooks-'));
  const saved = { ...process.env };
  t.after(async () => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    await rm(directory, { recursive: true, force: true });
  });
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const hooksPath = join(directory, 'hooks.json');
  const logPath = join(directory, 'requests.jsonl');
  await writeFile(hooksPath, JSON.stringify(hooks));
  await writeFile(
    join(bin, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => raw += chunk);
process.stdin.on('end', () => {
 const body = raw ? JSON.parse(raw) : null;
 fs.appendFileSync(process.env.CLQN_TEST_HOOK_LOG, JSON.stringify({args, body})+'\\n');
 if (process.env.CLQN_TEST_HOOK_ERROR) {
  process.stderr.write(process.env.CLQN_TEST_HOOK_ERROR); process.exitCode = 1; return;
 }
 const methodIndex = args.indexOf('--method');
 const method = methodIndex === -1 ? 'GET' : args[methodIndex + 1];
 if (method === 'GET') process.stdout.write(fs.readFileSync(process.env.CLQN_TEST_HOOKS, 'utf8'));
 else if (method === 'DELETE') process.stdout.write('');
 else process.stdout.write(JSON.stringify({id: method === 'PATCH' ? 42 : 91, config:{url:body.config.url,secret:body.config.secret}}));
});
`,
    { mode: 0o755 },
  );
  Object.assign(process.env, {
    PATH: bin,
    GH_HOST: 'enterprise.invalid',
    CLQN_TEST_HOOK_LOG: logPath,
    CLQN_TEST_HOOKS: hooksPath,
  });
  delete process.env.CLQN_TEST_HOOK_ERROR;
  const requests = async () => {
    try {
      return (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  return { directory, bin, logPath, hooksPath, requests };
}

function assertHostAndNoSecret(request) {
  assert.equal(request.args[0], 'api');
  assert.equal(request.args[request.args.indexOf('--hostname') + 1], 'github.com');
  assert.ok(!request.args.some((arg) => arg.includes(secret)));
}

test('GitHub webhook creation sends the secret only through stdin and returns only metadata', async (t) => {
  const f = await fixture(t, [[]]);
  const result = await configureGithubWebhook({ repository, url, secret });
  assert.deepEqual(result, { id: 91, url });
  assert.ok(!JSON.stringify(result).includes(secret));
  const requests = await f.requests();
  assert.equal(requests.length, 2);
  requests.forEach(assertHostAndNoSecret);
  assert.ok(requests[0].args.includes('--paginate'));
  assert.ok(requests[0].args.includes('--slurp'));
  assert.ok(requests[1].args.includes(`repos/${repository}/hooks`));
  assert.equal(requests[1].args[requests[1].args.indexOf('--method') + 1], 'POST');
  assert.equal(requests[1].args[requests[1].args.indexOf('--input') + 1], '-');
  assert.deepEqual(requests[1].body, {
    name: 'web',
    active: true,
    events: ['push'],
    config: { url, content_type: 'json', secret, insecure_ssl: '0' },
  });
});

test('GitHub webhook setup reuses an exact URL across paginated hooks and updates its secret', async (t) => {
  const f = await fixture(t, [
    [{ id: 11, config: { url: 'https://elsewhere.example/hook' } }],
    [{ id: 42, config: { url } }],
  ]);
  assert.deepEqual(await configureGithubWebhook({ repository, url, secret }), { id: 42, url });
  const requests = await f.requests();
  assert.equal(requests.length, 2);
  requests.forEach(assertHostAndNoSecret);
  assert.ok(requests[1].args.includes(`repos/${repository}/hooks/42`));
  assert.equal(requests[1].args[requests[1].args.indexOf('--method') + 1], 'PATCH');
  assert.equal(requests[1].body.name, undefined);
  assert.deepEqual(requests[1].body.events, ['push']);
  assert.equal(requests[1].body.config.secret, secret);
});

test('ambiguous webhook matches fail without creating, updating, or deleting any hook', async (t) => {
  const f = await fixture(t, [
    [
      { id: 1, config: { url } },
      { id: 2, config: { url } },
    ],
  ]);
  await assert.rejects(configureGithubWebhook({ repository, url, secret }));
  await assert.rejects(removeGithubWebhook({ repository, url }));
  const requests = await f.requests();
  assert.equal(requests.length, 2);
  assert.ok(
    requests.every(({ args }) => !args.includes('POST') && !args.includes('PATCH') && !args.includes('DELETE')),
  );
});

test('webhook removal deletes only the exact matching URL and is a no-op when absent', async (t) => {
  const f = await fixture(t, [
    [
      { id: 7, config: { url: 'https://elsewhere.example/hook' } },
      { id: 42, config: { url } },
    ],
  ]);
  assert.deepEqual(await removeGithubWebhook({ repository, url }), { removed: true });
  const requests = await f.requests();
  requests.forEach(assertHostAndNoSecret);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].args.includes(`repos/${repository}/hooks/42`));
  assert.equal(requests[1].args[requests[1].args.indexOf('--method') + 1], 'DELETE');
  await writeFile(f.hooksPath, JSON.stringify([[{ id: 7, config: { url: 'https://elsewhere.example/hook' } }]]));
  assert.deepEqual(await removeGithubWebhook({ repository, url }), { removed: false });
  assert.equal((await f.requests()).length, 3);
});

test('GitHub errors never expose the secret or raw child stderr', async (t) => {
  const f = await fixture(t, [[]]);
  process.env.CLQN_TEST_HOOK_ERROR = `raw private GitHub failure: ${secret}`;
  await assert.rejects(configureGithubWebhook({ repository, url, secret }), (error) => {
    assert.ok(!error.message.includes(secret));
    assert.ok(!error.message.includes('raw private GitHub failure'));
    assert.match(error.message, /GitHub|gh|webhook/i);
    return true;
  });
  assert.equal((await f.requests()).length, 1);
});

test('invalid repository, URL, and secret inputs are rejected before starting gh', async (t) => {
  const f = await fixture(t, [[]]);
  for (const badRepository of [
    '--help',
    'https://github.com/example/project',
    'example/project;touch',
    '../project',
    'example/project/extra',
  ]) {
    await assert.rejects(configureGithubWebhook({ repository: badRepository, url, secret }));
  }
  for (const badUrl of [
    'https://clqn.example/wrong/path',
    'https://user:password@clqn.example/hooks/github/2c753d10-6378-4b86-963d-be68a816366c',
    `${url}#fragment`,
    'http://remote.example/hooks/github/2c753d10-6378-4b86-963d-be68a816366c',
    'file:///tmp/hook',
  ]) {
    await assert.rejects(configureGithubWebhook({ repository, url: badUrl, secret }));
    await assert.rejects(removeGithubWebhook({ repository, url: badUrl }));
  }
  for (const badSecret of ['', 'short'])
    await assert.rejects(configureGithubWebhook({ repository, url, secret: badSecret }));
  assert.deepEqual(await f.requests(), []);
});

test('a missing GitHub CLI produces an actionable error without exposing setup values', async (t) => {
  const f = await fixture(t, [[]]);
  await rm(join(f.bin, 'gh'));
  await assert.rejects(configureGithubWebhook({ repository, url, secret }), (error) => {
    assert.match(error.message, /gh|GitHub CLI/i);
    assert.match(error.message, /install|required|PATH|available/i);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});
