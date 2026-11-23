import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { sourceNodeArgs } from '../../../scripts/test-node.js';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../../cli/src/index.ts', import.meta.url));

test('repository acceptance: orchestrator delegates, worker publishes isolated work, and the next task starts from integrated main', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests',
  timeout: 45_000,
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'clqn-repository-acceptance-')));
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 5 });
  const connection = createStore(process.env.TEST_DATABASE_URL!);
  const userIds: string[] = [];
  const clanIds: string[] = [];
  let server: ReturnType<typeof serve> | undefined;
  t.after(async () => {
    if (server) await new Promise((resolve) => server?.close(resolve));
    try {
      if (clanIds.length) {
        await sql`delete from events where clan_id in ${sql(clanIds)}`;
        await sql`delete from tasks where clan_id in ${sql(clanIds)}`;
        await sql`delete from credentials where user_id in ${sql(userIds)}`;
        await sql`delete from agents where clan_id in ${sql(clanIds)}`;
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
  const member = await connection.provisionUser(`${randomUUID()}@example.com`);
  userIds.push(leader.user.id, member.user.id);
  const clan = await connection.store.createClan(leader.user.id, 'Repository acceptance');
  clanIds.push(clan.id);
  await sql`insert into memberships (clan_id, user_id) values (${clan.id}, ${member.user.id})`;
  const orchestrator = await connection.store.registerAgent(leader.user, clan.id, 'Coordinator', 'orchestrator');
  const worker = await connection.store.registerAgent(member.user, clan.id, 'Worker');
  server = serve({ fetch: createApp(connection.store, connection.db).fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const actualGit = (await execute('which', ['git'], { encoding: 'utf8' })).stdout.trim();
  const remote = join(root, 'remote.git');
  const personal = join(root, 'personal');
  const integrator = join(root, 'integrator');
  const nextWorktree = join(root, 'next-worktree');
  const bin = join(root, 'bin');
  const prFile = join(root, 'pr.json');
  const logFile = join(root, 'commands.jsonl');
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
    CLQN_TEST_GIT: actualGit,
    CLQN_TEST_REMOTE: remote,
    CLQN_TEST_PR: prFile,
    CLQN_TEST_LOG: logFile,
    CLQN_TEST_INTEGRATOR: integrator,
  };
  delete env.GIT_CONFIG_COUNT;
  const git = async (cwd: string, args: string[]) =>
    (
      await execute(actualGit, ['-c', `core.hooksPath=${devNull}`, ...args], {
        cwd,
        env,
        encoding: 'utf8',
      })
    ).stdout.trim();
  await git(root, ['init', '--bare', remote]);
  await git(root, ['clone', remote, personal]);
  await writeFile(join(personal, 'README.md'), 'initial project\n');
  await git(personal, ['add', '.']);
  await git(personal, ['commit', '-m', 'base']);
  await git(personal, ['branch', '-M', 'main']);
  await git(personal, ['push', 'origin', 'main']);
  await git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const baseSha = await git(personal, ['rev-parse', 'HEAD']);
  await git(root, ['clone', remote, integrator]);
  await git(personal, ['remote', 'set-url', 'origin', 'https://github.com/test/project.git']);
  await writeFile(join(personal, 'README.md'), 'personal uncommitted edit\n');
  await writeFile(join(personal, 'private.txt'), 'personal untracked data\n');
  const personalStatus = await git(personal, ['status', '--porcelain=v1']);

  await mkdir(bin);
  await writeFile(
    join(bin, 'git'),
    `#!${process.execPath}
const fs = require('node:fs'); const cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLQN_TEST_LOG, JSON.stringify({file:'git',args})+'\\n');
const network = args.some(arg => ['fetch','push','ls-remote'].includes(arg));
const extra = network ? ['-c','url.'+process.env.CLQN_TEST_REMOTE+'.insteadOf=https://github.com/test/project.git','-c','protocol.file.allow=always'] : [];
const result = cp.spawnSync(process.env.CLQN_TEST_GIT,[...extra,...args],{stdio:'inherit'});
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs'); const cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLQN_TEST_LOG,JSON.stringify({file:'gh',args})+'\\n');
const git = (cwd, values) => cp.execFileSync(process.env.CLQN_TEST_GIT,['-c','core.hooksPath=${devNull}',...values],{cwd,encoding:'utf8'}).trim();
const path = process.env.CLQN_TEST_PR;
let pr = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path,'utf8')) : null;
if(args[1] === 'list') process.stdout.write(JSON.stringify(pr && pr.state === 'OPEN' ? [pr] : []));
else if(args[1] === 'create') {
 const branch = args[args.indexOf('--head')+1];
 const baseBranch = args[args.indexOf('--base')+1];
 const headSha = git(process.env.CLQN_TEST_REMOTE,['rev-parse','refs/heads/'+branch]);
 pr = {number:7,url:'https://github.com/test/project/pull/7',state:'OPEN',headRefName:branch,headRefOid:headSha,
  headRepository:{name:'project'},headRepositoryOwner:{login:'test'},baseRefName:baseBranch,isCrossRepository:false,
  mergeCommit:null,statusCheckRollup:[{__typename:'CheckRun',status:'COMPLETED',conclusion:'SUCCESS'}]};
 fs.writeFileSync(path,JSON.stringify(pr)); process.stdout.write(pr.url+'\\n');
} else if(args[1] === 'view' && pr) process.stdout.write(JSON.stringify(pr));
else if(args[1] === 'merge' && pr) {
 const expected = args[args.indexOf('--match-head-commit')+1];
 if(expected !== pr.headRefOid || git(process.env.CLQN_TEST_REMOTE,['rev-parse','refs/heads/'+pr.headRefName]) !== expected) process.exit(2);
 const cwd = process.env.CLQN_TEST_INTEGRATOR;
 git(cwd,['fetch','origin']); git(cwd,['switch',pr.baseRefName]);
 git(cwd,['merge','--squash','origin/'+pr.headRefName]); git(cwd,['commit','-m','Integrate PR #7']);
 git(cwd,['push','origin',pr.baseRefName]);
 pr.state = 'MERGED'; pr.mergeCommit = {oid:git(cwd,['rev-parse','HEAD'])};
 fs.writeFileSync(path,JSON.stringify(pr));
} else process.exit(3);
`,
    { mode: 0o755 },
  );
  const cliEnv = { ...env, PATH: `${bin}:${process.env.PATH}` };
  const call = async (token: string, args: string[], cwd = personal) =>
    JSON.parse(
      (
        await execute(process.execPath, [...sourceNodeArgs, cli, '--api-url', apiUrl, '--json', ...args], {
          env: { ...cliEnv, CLQN_TOKEN: token },
          cwd,
          encoding: 'utf8',
        })
      ).stdout,
    );

  const task = await call(orchestrator.token, ['task', 'add', 'Implement shared feature', '--code']);
  assert.equal(task.repository.slug, 'test/project');
  assert.equal(task.repository.baseSha, baseSha);
  assert.match(task.repository.branch, /^clqn\/task-[a-f0-9-]+$/);
  assert.equal(
    (await call(orchestrator.token, ['task', 'assign', task.id, '--agent', worker.agent.id])).assignedAgentId,
    worker.agent.id,
  );
  const prepared = await call(worker.token, ['task', 'start', task.id]);
  const worktree = prepared.path;
  assert.equal(prepared.task.ownerAgentId, worker.agent.id);
  assert.equal(prepared.baseSha, baseSha);
  assert.equal(await git(worktree, ['rev-parse', 'HEAD']), baseSha);
  await writeFile(join(worktree, 'feature.txt'), 'finished task\n');
  const resumed = await call(worker.token, ['task', 'start', task.id], worktree);
  assert.equal(resumed.path, worktree);
  assert.equal(await readFile(join(worktree, 'feature.txt'), 'utf8'), 'finished task\n');
  await git(worktree, ['add', 'feature.txt']);
  await git(worktree, ['commit', '-m', 'Implement feature']);
  const headSha = await git(worktree, ['rev-parse', 'HEAD']);
  const published = await call(worker.token, ['task', 'submit', task.id, '--body', 'Feature tested'], worktree);
  assert.equal(published.repository.headSha, headSha);
  assert.equal(published.repository.prUrl, 'https://github.com/test/project/pull/7');
  assert.equal(await git(remote, ['rev-parse', `refs/heads/${task.repository.branch}`]), headSha);
  const check = await call(orchestrator.token, ['task', 'check', task.id]);
  assert.equal(check.checksPassed, true);
  const merged = await call(orchestrator.token, ['task', 'merge', task.id]);
  const mergedSha = await git(remote, ['rev-parse', 'refs/heads/main']);
  assert.notEqual(mergedSha, headSha, 'Fixture performs an actual squash merge');
  assert.equal(merged.repository.state, 'merged');
  assert.equal(merged.repository.mergeCommitSha, mergedSha);
  assert.equal((await call(worker.token, ['task', 'done', task.id])).status, 'completed');
  const stored = await call(orchestrator.token, ['task', 'show', task.id]);
  assert.equal(stored.status, 'completed');
  assert.equal(stored.repository.headSha, headSha);
  assert.equal(stored.repository.mergeCommitSha, mergedSha);

  const nextTask = await call(orchestrator.token, [
    'task',
    'add',
    'Build on integrated feature',
    '--repo',
    'test/project',
    '--base-sha',
    mergedSha,
    '--branch',
    'clqn/acceptance-next',
  ]);
  await call(orchestrator.token, ['task', 'assign', nextTask.id, '--agent', worker.agent.id]);
  await call(worker.token, ['task', 'start', nextTask.id, '--from', personal, '--path', nextWorktree]);
  assert.equal(await git(nextWorktree, ['rev-parse', 'HEAD']), mergedSha);
  assert.equal(await readFile(join(nextWorktree, 'feature.txt'), 'utf8'), 'finished task\n');
  assert.equal(await git(personal, ['rev-parse', 'HEAD']), baseSha);
  assert.equal(await git(personal, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(await git(personal, ['status', '--porcelain=v1']), personalStatus);
  assert.equal(await readFile(join(personal, 'README.md'), 'utf8'), 'personal uncommitted edit\n');
  assert.equal(await readFile(join(personal, 'private.txt'), 'utf8'), 'personal untracked data\n');
  const events =
    await sql`select type from events where clan_id = ${clan.id} and resource_id = ${task.id} order by sequence`;
  for (const type of [
    'task.created',
    'task.assigned',
    'task.claimed',
    'task.repository_updated',
    'task.integrated',
    'task.completed',
  ]) {
    assert.ok(
      events.some((event) => event.type === type),
      `Missing audit event ${type}`,
    );
  }
  const commands = (await readFile(logFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line): { file: string; args: string[] } => JSON.parse(line));
  assert.ok(
    !commands.some(
      ({ file, args }) => file === 'git' && args.some((arg) => ['pull', 'reset', 'stash', '--force'].includes(arg)),
    ),
  );
  assert.ok(
    commands.some(({ file, args }) => file === 'gh' && args.includes('--match-head-commit') && args.includes(headSha)),
  );
});
