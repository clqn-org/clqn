import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ClqnClient, defaultChatSettings } from '@clqn/shared';
import { readConfig, readServer, writeConfig } from '../src/config.js';
import { chooseClan, savedClan, setupChatRepository, signIn, signOut } from '../src/setup.js';

type Handler = (request: IncomingMessage, body: unknown, response: ServerResponse) => void;

// Each test gets a private config directory and a local API that records requests.
async function fixture(t: TestContext, handler: Handler) {
  const directory = await mkdtemp(join(tmpdir(), 'clqn-setup-'));
  const requests: { path: string | undefined; authorization: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    handler(request, raw ? JSON.parse(raw) : undefined, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = { dir: process.env.CLQN_CONFIG_DIR, token: process.env.CLQN_TOKEN };
  process.env.CLQN_CONFIG_DIR = directory;
  delete process.env.CLQN_TOKEN;
  t.mock.method(console, 'error', () => undefined);
  t.after(async () => {
    if (previous.dir === undefined) delete process.env.CLQN_CONFIG_DIR;
    else process.env.CLQN_CONFIG_DIR = previous.dir;
    if (previous.token === undefined) delete process.env.CLQN_TOKEN;
    else process.env.CLQN_TOKEN = previous.token;
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { directory, requests, url };
}

const deviceStart = {
  handle: 'h'.repeat(43),
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://github.com/login/device',
  expiresIn: 30,
  interval: 5,
};

// Answer prompts in order and record what was printed.
function scripted(answers: string[]) {
  const questions: string[] = [];
  const printed: string[] = [];
  return {
    questions,
    printed,
    ask: async (question: string) => {
      questions.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`Unexpected prompt: ${question}`);
      return answer;
    },
    print: (text: string) => printed.push(text),
  };
}

test('GitHub sign-in saves only the clqn token and the server, and retries a temporary poll failure', async (t) => {
  const token = `clqn_${'a'.repeat(43)}`;
  const user = { id: randomUUID(), email: 'verified@example.com' };
  let polls = 0;
  const f = await fixture(t, (request, body, response) => {
    assert.equal(request.method, 'POST');
    if (request.url === '/auth/github/start') response.end(JSON.stringify(deviceStart));
    else if (++polls === 1) {
      response.writeHead(503);
      response.end(JSON.stringify({ error: { code: 'GITHUB_LOGIN_FAILED', message: 'Try again' } }));
    } else {
      assert.deepEqual(body, { handle: deviceStart.handle });
      response.end(JSON.stringify({ status: 'complete', user, token }));
    }
  });
  const clanId = randomUUID();
  await writeConfig(f.url, { token: 'stale', clanId });
  assert.deepEqual(await signIn(f.url), user);
  assert.equal(polls, 2);
  // A new sign-in keeps the selected clan.
  assert.deepEqual(await readConfig(f.url), { token, clanId });
  assert.equal(await readServer(), f.url);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  const printed = (console.error as unknown as { mock: { calls: { arguments: unknown[] }[] } }).mock.calls
    .map((call) => call.arguments.join(' '))
    .join('\n');
  assert.match(printed, /ABCD-EFGH/);
  assert.ok(!printed.includes(token));
});

test('choosing a clan opens an existing one, creates one, or reports no invitations', async (t) => {
  const userId = randomUUID();
  const existing = { id: randomUUID(), name: 'Existing', createdBy: userId, createdAt: new Date().toISOString() };
  const created = { ...existing, id: randomUUID(), name: basename(process.cwd()) };
  const token = `clqn_${'b'.repeat(43)}`;
  let clans = [existing];
  const saved: unknown[] = [];
  const f = await fixture(t, (request, body, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.url === `/v1/clans/${created.id}/chat/settings`) {
      saved.push(body);
      response.end(JSON.stringify(body));
    } else if (request.url === '/v1/clans' && request.method === 'POST') {
      assert.deepEqual(body, { name: created.name });
      response.writeHead(201);
      response.end(JSON.stringify(created));
    } else if (request.url === '/v1/clans') response.end(JSON.stringify({ clans }));
    else if (request.url === '/v1/invitations') response.end(JSON.stringify({ invitations: [] }));
    else if (request.url === '/v1/me') response.end(JSON.stringify({ id: userId, email: 'me@example.com' }));
    else response.writeHead(404).end();
  });
  const connect = async () => new ClqnClient(f.url, token);

  const pickExisting = scripted(['9', '1']);
  assert.deepEqual(await chooseClan({ connect, ...pickExisting }), existing);
  assert.match(pickExisting.printed[0]!, /1\. Existing\n {2}2\. Create a clan\n {2}3\. Join a clan/);
  assert.equal(pickExisting.questions.length, 2);

  // Returning users get the same choices, and Enter reopens their last clan.
  const returning = scripted(['']);
  assert.deepEqual(await chooseClan({ connect, current: existing.id, ...returning }), existing);
  assert.match(returning.printed[0]!, /1\. Existing \(last used\)\n {2}2\. Create a clan\n {2}3\. Join a clan/);
  assert.deepEqual(returning.questions, ['Enter a number: ']);

  assert.deepEqual(saved, []);

  // The leader of a new clan is a member too, and Enter picks full access.
  clans = [];
  const create = scripted(['2', '1', '', '']);
  assert.deepEqual(await chooseClan({ connect, ...create }), created);
  assert.match(create.printed.join('\n'), /No pending invitations\. Ask a clan leader to invite me@example\.com\./);
  assert.match(create.questions.at(-2)!, /^Clan name: $/);
  assert.match(create.printed.join('\n'), /1\. Full access \(no limits\)\n {2}2\. Custom/);
  assert.deepEqual(saved, [
    { approval: 'manual', tokenLimit: null, agentLimit: null, allowedModels: null, commands: 'sandboxed' },
  ]);
});

test('a saved clan the user no longer belongs to is forgotten so setup asks again', async (t) => {
  const userId = randomUUID();
  const kept = { id: randomUUID(), name: 'Kept', createdBy: userId, createdAt: new Date().toISOString() };
  const token = `clqn_${'k'.repeat(43)}`;
  const f = await fixture(t, (request, _body, response) => {
    if (request.url === '/v1/clans') response.end(JSON.stringify({ clans: [kept] }));
    else response.writeHead(404).end();
  });
  const api = new ClqnClient(f.url, token);
  assert.equal(await savedClan(f.url, api), undefined);
  await writeConfig(f.url, { token, clanId: kept.id });
  assert.equal(await savedClan(f.url, api), kept.id);
  await writeConfig(f.url, { token, clanId: randomUUID() });
  assert.equal(await savedClan(f.url, api), undefined);
  assert.deepEqual(await readConfig(f.url), { token });
});

function gitClone(directory: string) {
  const project = join(directory, 'project');
  execFileSync('git', ['init', '--quiet', project]);
  execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/owner/project.git']);
  return project;
}

test('chat setup links the verified origin only after the leader agrees', async (t) => {
  const clanId = randomUUID();
  const repository = {
    id: randomUUID(),
    clanId,
    slug: 'owner/project',
    createdAt: new Date().toISOString(),
    lastEventSequence: 17,
  };
  const secret = 'a'.repeat(64);
  let canStart = false;
  let linkRequests = 0;
  const f = await fixture(t, (request, body, response) => {
    if (request.url === `/v1/clans/${clanId}/chat`) {
      response.end(JSON.stringify({ session: null, clan: 'Project', canStart, settings: defaultChatSettings }));
    } else if (request.url === `/v1/clans/${clanId}/repositories` && request.method === 'GET') {
      response.end(JSON.stringify({ repositories: linkRequests ? [repository] : [] }));
    } else if (request.url === `/v1/clans/${clanId}/repositories` && request.method === 'POST') {
      assert.deepEqual(body, { slug: repository.slug });
      linkRequests += 1;
      response.end(JSON.stringify({ repository, webhook: { path: `/hooks/github/${repository.id}`, secret } }));
    } else response.writeHead(404).end();
  });
  const project = gitClone(f.directory);
  const api = new ClqnClient(f.url);
  const options = { api, clanId, project, server: f.url };
  assert.match((await setupChatRepository({ ...options, ...scripted([]) })).notice!, /ask your clan leader/);
  assert.equal(linkRequests, 0);

  const bin = join(f.directory, 'bin');
  const installLog = join(f.directory, 'hook.json');
  await mkdir(bin);
  await writeFile(
    join(bin, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('POST')) {
  fs.writeFileSync(${JSON.stringify(installLog)}, fs.readFileSync(0, 'utf8'));
  process.stdout.write('{"id":5}');
} else process.stdout.write('[[]]');
`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  process.env.PATH = [bin, previousPath].filter(Boolean).join(delimiter);
  canStart = true;
  const prompts = scripted(['y']);
  const linked = await setupChatRepository({ ...options, ...prompts });
  assert.deepEqual(linked, {
    sync: { repoPath: await realpath(project), repository: repository.slug, initialCursor: 17 },
  });
  assert.equal(linkRequests, 1);
  assert.match(prompts.questions[0]!, /Link owner\/project/);
  assert.ok(!JSON.stringify([linked, prompts.printed]).includes(secret));
  const webhook = JSON.parse(await readFile(installLog, 'utf8'));
  assert.deepEqual(webhook.events, ['push', 'pull_request']);
  assert.equal(webhook.config.secret, secret);
  assert.equal(webhook.config.url, `${f.url}/hooks/github/${repository.id}`);
  assert.deepEqual(await setupChatRepository({ ...options, ...scripted([]) }), linked);
  assert.equal(linkRequests, 1);
});

test('a skipped repository prompt stays skipped unless the clone gets linked', async (t) => {
  const clanId = randomUUID();
  const linked = {
    id: randomUUID(),
    clanId,
    slug: 'owner/project',
    createdAt: new Date().toISOString(),
    lastEventSequence: 29,
  };
  const other = { ...linked, id: randomUUID(), slug: 'owner/other' };
  const repositoriesPath = `/v1/clans/${clanId}/repositories`;
  let hasLink = false;
  const f = await fixture(t, (request, _body, response) => {
    assert.equal(request.method, 'GET');
    if (request.url === `/v1/clans/${clanId}/chat`) {
      response.end(JSON.stringify({ session: null, clan: 'Project', canStart: true, settings: defaultChatSettings }));
    } else if (request.url === repositoriesPath) {
      response.end(JSON.stringify({ repositories: [other], ...(hasLink ? { nextCursor: other.id } : {}) }));
    } else if (request.url === `${repositoriesPath}?after=${other.id}`) {
      response.end(JSON.stringify({ repositories: [linked] }));
    } else response.writeHead(404).end();
  });
  const project = gitClone(f.directory);
  const options = { api: new ClqnClient(f.url), clanId, project, server: f.url };
  const skipped = await setupChatRepository({ ...options, ...scripted(['n']) });
  assert.match(skipped.notice!, /run clqn repo link/);
  assert.equal(skipped.sync, undefined);
  assert.deepEqual(await setupChatRepository({ ...options, ...scripted([]) }), skipped);
  hasLink = true;
  assert.deepEqual(await setupChatRepository({ ...options, ...scripted([]) }), {
    sync: { repoPath: await realpath(project), repository: linked.slug, initialCursor: 29 },
  });
});

// Older servers asked for a fresh sign-in when listing or accepting invitations sent after the last one.
async function joinWithStaleSignIn(t: TestContext, refuseListing: boolean) {
  const stale = `clqn_${'s'.repeat(43)}`;
  const token = `clqn_${'f'.repeat(43)}`;
  const user = { id: randomUUID(), email: 'verified@example.com' };
  const clan = { id: randomUUID(), name: 'Second', createdBy: randomUUID(), createdAt: new Date().toISOString() };
  const invitations = [
    { clanId: randomUUID(), clanName: 'First', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    { clanId: clan.id, clanName: clan.name, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  ];
  const accepts: (string | undefined)[] = [];
  const lists: (string | undefined)[] = [];
  const saved: unknown[] = [];
  const f = await fixture(t, (request, body, response) => {
    if (request.url === `/v1/clans/${clan.id}/chat/settings`) {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      saved.push(body);
      response.end(JSON.stringify(body));
    } else if (request.url === '/auth/github/start') response.end(JSON.stringify(deviceStart));
    else if (request.url === '/auth/github/poll') response.end(JSON.stringify({ status: 'complete', user, token }));
    else if (request.url === '/v1/me') response.end(JSON.stringify(user));
    else if (request.url === '/v1/clans') response.end(JSON.stringify({ clans: [] }));
    else if (request.url === '/v1/invitations') {
      lists.push(request.headers.authorization);
      if (refuseListing && request.headers.authorization === `Bearer ${stale}`) {
        response.writeHead(403);
        response.end(JSON.stringify({ error: { code: 'INVITATION_LOGIN_REQUIRED', message: 'Sign in again' } }));
      } else response.end(JSON.stringify({ invitations }));
    } else if (request.url === '/v1/invitations/accept') {
      assert.deepEqual(body, { clanId: clan.id });
      accepts.push(request.headers.authorization);
      if (request.headers.authorization === `Bearer ${stale}`) {
        response.writeHead(403);
        response.end(JSON.stringify({ error: { code: 'INVITATION_LOGIN_REQUIRED', message: 'Sign in again' } }));
      } else response.end(JSON.stringify(clan));
    } else response.writeHead(404).end();
  });
  await writeConfig(f.url, { token: stale });
  const connect = async () => new ClqnClient(f.url, (await readConfig(f.url)).token);
  // Custom limits: invalid answers are asked again; blank models allow any.
  const custom = ['2', '1.5', '5000', '', ' a, b ,c '];
  // After the fresh sign-in, the chosen invitation is accepted without picking it again.
  const prompts = scripted(['2', '2', ...custom]);
  const reauthenticate = async (id: string) => {
    await signIn(f.url, id);
  };
  assert.deepEqual(await chooseClan({ connect, reauthenticate, ...prompts }), clan);
  assert.deepEqual(saved, [
    { approval: 'manual', tokenLimit: 5000, agentLimit: null, allowedModels: ['a', 'b', 'c'], commands: 'sandboxed' },
  ]);
  assert.deepEqual(prompts.questions.slice(-5), [
    'Enter a number (1): ',
    'Token limit (blank for none): ',
    'Token limit (blank for none): ',
    'Agent count (blank for none): ',
    'Allowed models, comma-separated (blank for any): ',
  ]);
  if (refuseListing) {
    assert.deepEqual(lists, [`Bearer ${stale}`, `Bearer ${token}`]);
    assert.deepEqual(accepts, [`Bearer ${token}`]);
  } else {
    assert.deepEqual(lists, [`Bearer ${stale}`]);
    assert.deepEqual(accepts, [`Bearer ${stale}`, `Bearer ${token}`]);
  }
  assert.match(prompts.printed.join('\n'), /1\. First\n {2}2\. Second/);
  assert.equal((await readConfig(f.url)).token, token);
}

test('joining a clan through an older server signs in again and retries accepting', (t) =>
  joinWithStaleSignIn(t, false));

test('joining a clan through an older server signs in again and retries listing', (t) => joinWithStaleSignIn(t, true));

test('sign-in for an invitation rejects a different GitHub account without saving it', async (t) => {
  const token = `clqn_${'d'.repeat(43)}`;
  const f = await fixture(t, (request, _body, response) => {
    if (request.url === '/auth/github/start') response.end(JSON.stringify(deviceStart));
    else if (request.url === '/auth/github/poll')
      response.end(JSON.stringify({ status: 'complete', user: { id: randomUUID(), email: 'b@example.com' }, token }));
    else if (request.url === '/v1/logout') response.end(JSON.stringify({ revoked: true }));
    else response.writeHead(404).end();
  });
  await writeConfig(f.url, { token: 'original' });
  await assert.rejects(signIn(f.url, randomUUID()), /GitHub account that received the invitation/);
  assert.deepEqual(f.requests.at(-1), { path: '/v1/logout', authorization: `Bearer ${token}` });
  assert.deepEqual(await readConfig(f.url), { token: 'original' });
});

test('sign out revokes the saved token and removes local credentials and clan selection', async (t) => {
  const token = `clqn_${'e'.repeat(43)}`;
  let revoke = true;
  const f = await fixture(t, (request, _body, response) => {
    assert.equal(request.url, '/v1/logout');
    if (revoke) response.end(JSON.stringify({ revoked: true }));
    else response.writeHead(503).end(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Down' } }));
  });
  await writeConfig(f.url, { token, clanId: randomUUID() });
  assert.equal(await signOut(f.url), 'Signed out.');
  assert.deepEqual(f.requests, [{ path: '/v1/logout', authorization: `Bearer ${token}` }]);
  assert.deepEqual(await readdir(f.directory), []);

  // Local removal still happens when the server cannot revoke the token; an environment token is left alone.
  revoke = false;
  await writeConfig(f.url, { token });
  process.env.CLQN_TOKEN = 'env_token';
  assert.match(await signOut(f.url), /could not be revoked.*CLQN_TOKEN is still set/);
  assert.deepEqual(await readConfig(f.url), {});
});
