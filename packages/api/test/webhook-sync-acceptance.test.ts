import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ClqnClient } from '@clqn/shared';
import { serve } from '@hono/node-server';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { MainSyncResult } from '../../cli/src/git.js';
import { runMcpSync } from '../../cli/src/mcp-sync.js';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));

test('webhook sync acceptance: main notifications trigger Git fetches while idle polls and task branches do not', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
  timeout: 45_000,
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'clqn-webhook-sync-')));
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 5 });
  const connection = createStore(process.env.TEST_DATABASE_URL!);
  const userIds: string[] = [];
  const clanIds: string[] = [];
  let server: ReturnType<typeof serve> | undefined;
  const controller = new AbortController();
  let syncing: Promise<void> | undefined;
  t.after(async () => {
    controller.abort();
    await syncing;
    if (server) await new Promise((resolve) => server?.close(resolve));
    try {
      if (clanIds.length) {
        await sql`delete from github_deliveries where binding_id in (select id from linked_repositories where clan_id in ${sql(clanIds)})`;
        await sql`delete from linked_repositories where clan_id in ${sql(clanIds)}`;
        await sql`delete from events where clan_id in ${sql(clanIds)}`;
        await sql`delete from credentials where user_id in ${sql(userIds)}`;
        await sql`delete from memberships where clan_id in ${sql(clanIds)}`;
        await sql`delete from clans where id in ${sql(clanIds)}`;
      }
      if (userIds.length) await sql`delete from users where id in ${sql(userIds)}`;
    } finally {
      await connection.close();
      await sql.end();
      await rm(root, { recursive: true, force: true });
    }
  });
  await migrate(drizzle(sql), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const leader = await connection.provisionUser(`${randomUUID()}@example.com`);
  userIds.push(leader.user.id);
  const clan = await connection.store.createClan(leader.user.id, 'Webhook sync acceptance');
  clanIds.push(clan.id);
  const app = createApp(connection.store, connection.db, { githubWebhookSecret: 'test-webhook-master-'.repeat(4) });
  let eventReads = 0;
  server = serve({
    fetch: (request) => {
      if (new URL(request.url).pathname === `/v1/clans/${clan.id}/events`) eventReads += 1;
      return app.fetch(request);
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  await once(server, 'listening');
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = new ClqnClient(apiUrl, leader.token);

  const actualGit = (await execute('which', ['git'], { encoding: 'utf8' })).stdout.trim();
  const remote = join(root, 'remote.git');
  const personal = join(root, 'personal');
  const taskPath = join(root, 'active-task');
  const writer = join(root, 'writer');
  const bin = join(root, 'bin');
  const gitLog = join(root, 'git.jsonl');
  const ghLog = join(root, 'gh.jsonl');
  const hookFile = join(root, 'hook.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    CLQN_CONFIG_DIR: join(root, 'config'),
    CLQN_CLAN_ID: clan.id,
    CLQN_TOKEN: leader.token,
    CLQN_TEST_GIT: actualGit,
    CLQN_TEST_REMOTE: remote,
    CLQN_TEST_GIT_LOG: gitLog,
    CLQN_TEST_GH_LOG: ghLog,
    CLQN_TEST_HOOK: hookFile,
  };
  delete env.GIT_CONFIG_COUNT;
  const git = async (cwd: string, args: string[]) =>
    (
      await execute(actualGit, ['-c', `core.hooksPath=${devNull}`, ...args], { cwd, env, encoding: 'utf8' })
    ).stdout.trim();
  await git(root, ['init', '--bare', remote]);
  await git(root, ['clone', remote, personal]);
  await writeFile(join(personal, 'README.md'), 'base project\n');
  await git(personal, ['add', '.']);
  await git(personal, ['commit', '-m', 'base']);
  await git(personal, ['branch', '-M', 'main']);
  await git(personal, ['push', 'origin', 'main']);
  await git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const baseSha = await git(personal, ['rev-parse', 'HEAD']);
  await git(root, ['clone', remote, writer]);
  await git(personal, ['worktree', 'add', '-b', 'task/active', taskPath, baseSha]);
  await writeFile(join(taskPath, 'draft.txt'), 'unfinished task edits\n');
  const taskStatus = await git(taskPath, ['status', '--porcelain=v1']);
  await git(personal, ['remote', 'set-url', 'origin', 'https://github.com/test/project.git']);
  await mkdir(bin);
  await writeFile(
    join(bin, 'git'),
    `#!${process.execPath}
const fs=require('node:fs'); const cp=require('node:child_process');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.CLQN_TEST_GIT_LOG,JSON.stringify(args)+'\\n');
const network=args.some(arg=>['fetch','push','ls-remote'].includes(arg));
const extra=network?['-c','url.'+process.env.CLQN_TEST_REMOTE+'.insteadOf=https://github.com/test/project.git','-c','protocol.file.allow=always']:[];
const result=cp.spawnSync(process.env.CLQN_TEST_GIT,[...extra,...args],{stdio:'inherit'});
process.exit(result.status??1);
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, 'gh'),
    `#!${process.execPath}
const fs=require('node:fs'); const args=process.argv.slice(2); let raw='';
process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>raw+=chunk);
process.stdin.on('end',()=>{
 const body=raw?JSON.parse(raw):null;
 fs.appendFileSync(process.env.CLQN_TEST_GH_LOG,JSON.stringify({args,body})+'\\n');
 const path=process.env.CLQN_TEST_HOOK;
 const methodIndex=args.indexOf('--method'); const method=methodIndex<0?'GET':args[methodIndex+1];
 if(method==='GET') process.stdout.write(JSON.stringify([fs.existsSync(path)?[JSON.parse(fs.readFileSync(path,'utf8'))]:[]]));
 else if(method==='POST'||method==='PATCH'){
  const hook={id:91,config:body.config,active:body.active,events:body.events};
  fs.writeFileSync(path,JSON.stringify(hook)); process.stdout.write(JSON.stringify(hook));
 }else process.exit(3);
});
`,
    { mode: 0o755 },
  );
  const cliEnv = { ...env, PATH: `${bin}:${process.env.PATH}` };
  const linked = await execute(process.execPath, [cli, '--api-url', apiUrl, '--json', 'repo', 'link'], {
    cwd: personal,
    env: cliEnv,
    encoding: 'utf8',
  });
  const setup = await api.linkRepository(clan.id, 'test/project');
  assert.ok(!linked.stdout.includes(setup.webhook.secret));
  assert.ok(!linked.stderr.includes(setup.webhook.secret));
  const hook = JSON.parse(await readFile(hookFile, 'utf8'));
  assert.equal(hook.config.secret, setup.webhook.secret);
  assert.equal(hook.config.url, new URL(setup.webhook.path, apiUrl).href);
  assert.equal(hook.config.content_type, 'json');
  assert.deepEqual(hook.events, ['push']);
  const setupCalls = (await readFile(ghLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line): { args: string[]; body?: { config?: { secret?: string } } } => JSON.parse(line));
  assert.ok(setupCalls.every(({ args }) => !args.some((arg) => arg.includes(setup.webhook.secret))));
  assert.ok(
    setupCalls.some(({ args, body }) => args.includes('--input') && body?.config?.secret === setup.webhook.secret),
  );

  const fetchCount = async () =>
    (await readFile(gitLog, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line): string[] => JSON.parse(line))
      .filter((args) => args.includes('fetch')).length;
  let stderr = '';
  const results: MainSyncResult[] = [];
  // Run the same automatic listener used by MCP, with short test-only intervals.
  const savedEnv = { ...process.env };
  Object.assign(process.env, cliEnv);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  syncing = runMcpSync(api, clan.id, {
    repoPath: taskPath,
    signal: controller.signal,
    pollIntervalMs: 25,
    fallbackIntervalMs: 60000,
    onResult: (result) => results.push(result),
    onError: (error) => {
      stderr += String(error);
    },
  });
  const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 12_000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for watcher: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await waitFor(() => results.some((result) => result.status === 'unchanged'));
  const beforeIdle = eventReads;
  await waitFor(() => eventReads >= beforeIdle + 2);
  assert.equal(await fetchCount(), 1, 'idle clan polling must not repeatedly fetch Git');

  await writeFile(join(writer, 'merged.txt'), 'new main code\n');
  await git(writer, ['add', '.']);
  await git(writer, ['commit', '-m', 'update main']);
  await git(writer, ['push', 'origin', 'main']);
  const mainSha = await git(writer, ['rev-parse', 'HEAD']);
  const deliver = async (ref: string, deliveryId = randomUUID()) => {
    const raw = JSON.stringify({ repository: { full_name: 'test/project' }, ref, after: mainSha, deleted: false });
    const response = await fetch(new URL(setup.webhook.path, apiUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': `sha256=${createHmac('sha256', setup.webhook.secret).update(raw).digest('hex')}`,
      },
      body: raw,
    });
    assert.equal(response.status, 200);
    return { body: await response.json(), deliveryId };
  };
  const ignored = await deliver('refs/heads/task/active');
  assert.equal(ignored.body.ignored, true);
  const afterIgnored = eventReads;
  await waitFor(() => eventReads >= afterIgnored + 2);
  assert.equal(await fetchCount(), 1, 'feature pushes must not trigger Git fetches');
  assert.equal(await git(personal, ['rev-parse', 'HEAD']), baseSha);

  const accepted = await deliver('refs/heads/main');
  await waitFor(() => results.some((result) => result.status === 'updated' && result.headSha === mainSha));
  assert.equal(await fetchCount(), 2, 'a main event should trigger one additional fetch');
  assert.equal(await readFile(join(personal, 'merged.txt'), 'utf8'), 'new main code\n');
  assert.equal(await git(taskPath, ['rev-parse', 'HEAD']), baseSha);
  assert.equal(await git(taskPath, ['status', '--porcelain=v1']), taskStatus);
  assert.equal(await readFile(join(taskPath, 'draft.txt'), 'utf8'), 'unfinished task edits\n');

  assert.equal((await deliver('refs/heads/main', accepted.deliveryId)).body.duplicate, true);
  const afterDuplicate = eventReads;
  await waitFor(() => eventReads >= afterDuplicate + 2);
  assert.equal(await fetchCount(), 2, 'a replayed delivery must not trigger another fetch');
  const [events] =
    await sql`select count(*)::integer as n from events where clan_id = ${clan.id} and type = 'repository.main_changed'`;
  assert.equal(events?.n, 1);
  controller.abort();
  await syncing;
  assert.equal(stderr, '');
});
