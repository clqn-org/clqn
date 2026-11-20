import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, chmod } from 'node:fs/promises';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { runMcpSync } from '../dist/mcp-sync.js';
import { prepareWorktree, publishWorktree, inspectPullRequest, mergePullRequest, syncMain, localRepository, repositoryForNewTask, taskWorktreeLocation, openTaskWorktree } from '../dist/git.js';

const execute = promisify(execFile);
const git = async (cwd, args) => (await execute('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
async function fixture(t) {
  const actualGit = (await execute('which', ['git'], { encoding: 'utf8' })).stdout.trim();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'clqn-git-')));
  const saved = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(root, { recursive: true, force: true });
  });
  process.env.CLQN_CONFIG_DIR = join(root, 'config');
  delete process.env.CLQN_TOKEN;
  delete process.env.CLQN_CLAN_ID;
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  delete process.env.GIT_CONFIG_COUNT;
  const remote = join(root, 'remote.git');
  const repoPath = join(root, 'personal');
  await git(root, ['init', '--bare', remote]);
  await git(root, ['clone', remote, repoPath]);
  await git(repoPath, ['config', 'user.email', 'test@example.com']);
  await git(repoPath, ['config', 'user.name', 'Test']);
  await writeFile(join(repoPath, 'file.txt'), 'base\n');
  await git(repoPath, ['add', '.']);
  await git(repoPath, ['commit', '-m', 'base']);
  await git(repoPath, ['branch', '-M', 'main']);
  await git(repoPath, ['push', '-u', 'origin', 'main']);
  const baseSha = await git(repoPath, ['rev-parse', 'HEAD']);
  await git(repoPath, ['remote', 'set-url', 'origin', 'https://github.com/test/project.git']);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const logPath = join(root, 'commands.jsonl');
  const prPath = join(root, 'pr.json');
  const ghScript = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLQN_TEST_LOG, JSON.stringify({file:'gh',args})+'\\n');
const path = process.env.CLQN_TEST_PR;
const pr = JSON.parse(fs.readFileSync(path, 'utf8'));
if(args[1] === 'list') process.stdout.write(JSON.stringify(process.env.CLQN_TEST_PR_EXISTS === '1' ? [pr] : []));
else if(args[1] === 'view') process.stdout.write(JSON.stringify(pr));
else if(args[1] === 'create') process.stdout.write(pr.url+'\\n');
else if(args[1] === 'merge') {
 if(process.env.CLQN_TEST_MERGE_PENDING !== '1') {
  pr.state = 'MERGED'; pr.mergeCommit = {oid: 'a'.repeat(40)};
  fs.writeFileSync(path,JSON.stringify(pr));
 }
} else process.exit(1);
`;
  const gitScript = `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLQN_TEST_LOG,JSON.stringify({file:'git',args})+'\\n');
const network = args.some(x => ['fetch','push','ls-remote'].includes(x));
if (args.includes('fetch') && process.env.CLQN_TEST_FAIL_FETCH && fs.existsSync(process.env.CLQN_TEST_FAIL_FETCH)) process.exit(65);
const extra = network ? ['-c','url.'+process.env.CLQN_TEST_REMOTE+'.insteadOf=https://github.com/test/project.git','-c','protocol.file.allow=always'] : [];
const result = cp.spawnSync(process.env.CLQN_TEST_GIT,[...extra,...args],{stdio:'inherit'});
process.exit(result.status ?? 1);
`;
  await writeFile(join(bin, 'git'), gitScript); await chmod(join(bin, 'git'), 0o755);
  await writeFile(join(bin, 'gh'), ghScript); await chmod(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.CLQN_TEST_GIT = actualGit;
  process.env.CLQN_TEST_REMOTE = remote;
  process.env.CLQN_TEST_LOG = logPath;
  process.env.CLQN_TEST_PR = prPath;
  delete process.env.CLQN_TEST_PR_EXISTS;
  delete process.env.CLQN_TEST_MERGE_PENDING;
  const repository = { slug: 'test/project', baseBranch: 'main', baseSha, branch: 'clqn/task-123' };
  const worktreePath = join(root, 'task');
  const pr = (headSha, overrides = {}) => ({
    number: 7, url: 'https://github.com/test/project/pull/7', state: 'OPEN',
    headRefName: repository.branch, headRefOid: headSha, headRepository: { name: 'project' },
    headRepositoryOwner: { login: 'test' }, baseRefName: 'main', isCrossRepository: false,
    mergeCommit: null, statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    ...overrides,
  });
  const savePr = (value) => writeFile(prPath, JSON.stringify(value));
  const commands = async () => (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { root, repoPath, worktreePath, repository, baseSha, savePr, pr, commands, remote };
}

test('preparing a task worktree preserves a dirty personal checkout and starts at the recorded SHA', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repoPath, 'file.txt'), 'personal changes\n');
  await writeFile(join(f.repoPath, 'private.txt'), 'untracked\n');
  const before = await git(f.repoPath, ['status', '--porcelain=v1']);
  const prepared = await prepareWorktree(f);
  assert.deepEqual(prepared, { path: f.worktreePath, branch: f.repository.branch, baseSha: f.baseSha });
  assert.equal(await git(f.worktreePath, ['rev-parse', 'HEAD']), f.baseSha);
  assert.equal(await git(f.repoPath, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(await git(f.repoPath, ['status', '--porcelain=v1']), before);
  assert.equal(await readFile(join(f.repoPath, 'file.txt'), 'utf8'), 'personal changes\n');
  const commands = await f.commands();
  assert.ok(commands.some(({args}) => args.includes('fetch')));
  assert.ok(!commands.some(({args}) => args.some(x => ['pull', 'reset', 'stash', '--force'].includes(x))));
});

test('preparing refuses the wrong origin, unsafe refs, existing paths and an unrelated base', async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareWorktree({ ...f, repository: { ...f.repository, slug: 'other/repo' } }), /Origin does not match/);
  await git(f.repoPath, ['remote', 'set-url', '--push', 'origin', 'https://github.com/other/project.git']);
  await assert.rejects(prepareWorktree(f), /Origin does not match/);
  await git(f.repoPath, ['remote', 'set-url', '--push', 'origin', 'https://github.com/test/project.git']);
  for (const branch of ['--force', '../main', 'main@{1}', 'refs/heads/task', 'main;touch']) {
    await assert.rejects(prepareWorktree({ ...f, repository: { ...f.repository, branch } }));
  }
  await assert.rejects(prepareWorktree({ ...f, worktreePath: join(f.repoPath, 'task') }), /outside/);
  await assert.rejects(prepareWorktree({ ...f, worktreePath: join(f.repoPath, '..task') }), /outside/);
  await assert.rejects(prepareWorktree({ ...f, worktreePath: f.repoPath }), /already exists/);
  await git(f.repoPath, ['switch', '-c', 'unrelated']);
  await writeFile(join(f.repoPath, 'extra.txt'), 'not on main');
  await git(f.repoPath, ['add', '.']); await git(f.repoPath, ['commit', '-m', 'other']);
  const other = await git(f.repoPath, ['rev-parse', 'HEAD']);
  await assert.rejects(prepareWorktree({ ...f, repository: { ...f.repository, baseSha: other } }), /not on the fetched/);
});

async function taskCommit(f) {
  await prepareWorktree(f);
  await writeFile(join(f.worktreePath, 'task.txt'), 'task changes');
  await git(f.worktreePath, ['add', '.']); await git(f.worktreePath, ['commit', '-m', 'task']);
  return git(f.worktreePath, ['rev-parse', 'HEAD']);
}

test('publish pushes without force, creates or reuses the exact PR, and leaves the personal checkout alone', async (t) => {
  const f = await fixture(t);
  const headSha = await taskCommit(f);
  await f.savePr(f.pr(headSha));
  process.env.GH_HOST = 'enterprise.invalid';
  const result = await publishWorktree({ ...f, title: 'Task result', body: 'Reviewed task work' });
  assert.deepEqual(result, { headSha, prNumber: 7, prUrl: 'https://github.com/test/project/pull/7' });
  assert.equal(await git(f.repoPath, ['symbolic-ref', '--short', 'HEAD']), 'main');
  process.env.CLQN_TEST_PR_EXISTS = '1';
  assert.deepEqual(await publishWorktree({ ...f, title: 'Task result' }), result);
  await assert.rejects(prepareWorktree({ ...f, worktreePath: join(f.root, 'duplicate') }), /already exists on origin/);
  const commands = await f.commands();
  const pushes = commands.filter(({file,args}) => file === 'git' && args.includes('push'));
  assert.equal(pushes.length, 2);
  assert.ok(pushes.every(({args}) => args.includes(`HEAD:refs/heads/${f.repository.branch}`) && !args.includes('--force')));
  assert.equal(commands.filter(({file,args}) => file === 'gh' && args[1] === 'create').length, 1);
  assert.ok(commands.filter(({file}) => file === 'gh').every(({args}) => args[args.indexOf('--repo') + 1] === 'github.com/test/project'));
});

test('a released task resumes from its reported head on origin, and refuses a different remote head', async (t) => {
  const f = await fixture(t);
  const headSha = await taskCommit(f);
  await git(f.worktreePath, ['push', 'origin', `HEAD:refs/heads/${f.repository.branch}`]);
  // A new owner has neither the old worktree nor the local task branch.
  await git(f.repoPath, ['worktree', 'remove', f.worktreePath]);
  await git(f.repoPath, ['branch', '-D', f.repository.branch]);
  await assert.rejects(prepareWorktree({ ...f, repository: { ...f.repository, headSha: f.baseSha } }), /differs from the reported head/);
  const prepared = await prepareWorktree({ ...f, repository: { ...f.repository, headSha } });
  assert.deepEqual(prepared, { path: f.worktreePath, branch: f.repository.branch, baseSha: f.baseSha });
  assert.equal(await git(f.worktreePath, ['rev-parse', 'HEAD']), headSha);
  assert.equal(await git(f.worktreePath, ['symbolic-ref', '--short', 'HEAD']), f.repository.branch);
});

test('publish refuses dirty worktrees, the wrong branch, missing commits, and a mismatched PR', async (t) => {
  const f = await fixture(t);
  await prepareWorktree(f);
  await assert.rejects(publishWorktree({ ...f, title: 'Task result' }), /no commits/);
  await writeFile(join(f.worktreePath, 'task.txt'), 'uncommitted');
  await assert.rejects(publishWorktree({ ...f, title: 'Task result' }), /Commit or remove/);
  await git(f.worktreePath, ['add', '.']); await git(f.worktreePath, ['commit', '-m', 'task']);
  const headSha = await git(f.worktreePath, ['rev-parse', 'HEAD']);
  await assert.rejects(publishWorktree({ ...f, repository: { ...f.repository, branch: 'other' }, title: 'Task result' }), /not on the task branch/);
  await f.savePr(f.pr(headSha, { headRepositoryOwner: { login: 'attacker' } }));
  process.env.CLQN_TEST_PR_EXISTS = '1';
  await assert.rejects(publishWorktree({ ...f, title: 'Task result' }), /does not match/);
});

test('PR inspection validates identity and treats pending, failed, skipped-only, and missing checks as unpassed', async (t) => {
  const f = await fixture(t);
  const input = { repository: f.repository, prNumber: 7 };
  for (const statusCheckRollup of [[], null,
    [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }],
    [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
    [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }],
    [{ __typename: 'StatusContext', state: 'PENDING' }],
  ]) {
    await f.savePr(f.pr(f.baseSha, { statusCheckRollup }));
    assert.equal((await inspectPullRequest(input)).checksPassed, false);
  }
  await f.savePr(f.pr(f.baseSha));
  assert.equal((await inspectPullRequest(input)).checksPassed, true);
  await f.savePr(f.pr(f.baseSha, { headRefName: 'other' }));
  await assert.rejects(inspectPullRequest(input), /does not match/);
  await f.savePr(f.pr(f.baseSha, { url: 'https://evil.example/pull/7' }));
  await assert.rejects(inspectPullRequest(input), /does not match/);
});

test('merge matches the reviewed head, respects pending queues, and reports only GitHub-confirmed merges', async (t) => {
  const f = await fixture(t);
  const input = { repository: f.repository, prNumber: 7, headSha: f.baseSha };
  await f.savePr(f.pr(f.baseSha, { statusCheckRollup: [] }));
  await assert.rejects(mergePullRequest(input), /at least one successful check/);
  await f.savePr(f.pr('b'.repeat(40)));
  await assert.rejects(mergePullRequest(input), /head changed/);
  await f.savePr(f.pr(f.baseSha));
  process.env.CLQN_TEST_MERGE_PENDING = '1';
  assert.equal((await mergePullRequest(input)).state, 'OPEN');
  delete process.env.CLQN_TEST_MERGE_PENDING;
  assert.equal((await mergePullRequest(input)).state, 'MERGED');
  assert.equal((await mergePullRequest(input)).state, 'MERGED');
  const merges = (await f.commands()).filter(({file,args}) => file === 'gh' && args[1] === 'merge');
  assert.equal(merges.length, 2);
  assert.ok(merges.every(({args}) => args.includes('--match-head-commit') && args.includes(f.baseSha)
    && !args.includes('--admin') && !args.includes('--auto')));
});


async function advanceMain(f) {
  const writer = join(f.root, 'writer');
  await git(f.root, ['clone', '--branch', 'main', f.remote, writer]);
  await git(writer, ['config', 'user.email', 'test@example.com']);
  await git(writer, ['config', 'user.name', 'Test']);
  await writeFile(join(writer, 'merged.txt'), 'merged task result\n');
  await git(writer, ['add', '.']); await git(writer, ['commit', '-m', 'merge task result']);
  await git(writer, ['push', 'origin', 'main']);
  return git(writer, ['rev-parse', 'HEAD']);
}

test('main sync fast-forwards clean main without updating active task worktrees or fetching their branches', async (t) => {
  const f = await fixture(t);
  await prepareWorktree(f);
  await writeFile(join(f.worktreePath, 'task-draft.txt'), 'active task edits\n');
  const taskStatus = await git(f.worktreePath, ['status', '--porcelain=v1']);
  const remoteSha = await advanceMain(f);
  const result = await syncMain({ repoPath: f.repoPath, repository: f.repository.slug });
  assert.deepEqual(result, { repository: 'test/project', path: f.repoPath, branch: 'main', status: 'updated',
    previousSha: f.baseSha, headSha: remoteSha, remoteSha });
  assert.equal(await readFile(join(f.repoPath, 'merged.txt'), 'utf8'), 'merged task result\n');
  assert.equal(await git(f.worktreePath, ['rev-parse', 'HEAD']), f.baseSha);
  assert.equal(await git(f.worktreePath, ['status', '--porcelain=v1']), taskStatus);
  assert.equal(await readFile(join(f.worktreePath, 'task-draft.txt'), 'utf8'), 'active task edits\n');
  assert.equal((await syncMain({ repoPath: f.repoPath, repository: f.repository.slug })).status, 'unchanged');
  const syncFetches = (await f.commands()).filter(({ args }) => args.includes('fetch')).slice(1);
  assert.ok(syncFetches.every(({ args }) => args.includes('refs/heads/main:refs/remotes/origin/main') && !args.includes('--all')));
});

test('main sync skips tracked or untracked changes, even with autostash configured', async (t) => {
  const f = await fixture(t);
  await git(f.repoPath, ['config', 'merge.autostash', 'true']);
  await advanceMain(f);
  await writeFile(join(f.repoPath, 'file.txt'), 'personal main edits\n');
  const tracked = await syncMain({ repoPath: f.repoPath, repository: f.repository.slug });
  assert.equal(tracked.reason, 'dirty');
  assert.equal(await git(f.repoPath, ['rev-parse', 'HEAD']), f.baseSha);
  assert.equal(await readFile(join(f.repoPath, 'file.txt'), 'utf8'), 'personal main edits\n');
  await git(f.repoPath, ['restore', 'file.txt']);
  await writeFile(join(f.repoPath, 'merged.txt'), 'personal untracked file\n');
  assert.equal((await syncMain({ repoPath: f.repoPath, repository: f.repository.slug })).reason, 'dirty');
  assert.equal(await readFile(join(f.repoPath, 'merged.txt'), 'utf8'), 'personal untracked file\n');
  assert.equal(await git(f.repoPath, ['rev-parse', 'HEAD']), f.baseSha);
  assert.ok(!(await f.commands()).some(({ args }) => args.includes('stash') || args.includes('reset')));
});

test('main sync skips local commits and divergence instead of rebasing, merging, or resetting them', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repoPath, 'local.txt'), 'personal local commit\n');
  await git(f.repoPath, ['add', '.']); await git(f.repoPath, ['commit', '-m', 'local main work']);
  const localSha = await git(f.repoPath, ['rev-parse', 'HEAD']);
  assert.equal((await syncMain({ repoPath: f.repoPath, repository: f.repository.slug })).reason, 'local_commits');
  await advanceMain(f);
  const result = await syncMain({ repoPath: f.repoPath, repository: f.repository.slug });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'diverged');
  assert.equal(await git(f.repoPath, ['rev-parse', 'HEAD']), localSha);
  assert.ok(!(await f.commands()).some(({ args }) => args.includes('merge') || args.includes('rebase') || args.includes('reset')));
});

test('main sync never switches or advances a checked-out feature branch', async (t) => {
  const f = await fixture(t);
  await git(f.repoPath, ['switch', '-c', 'feature/active']);
  await writeFile(join(f.repoPath, 'draft.txt'), 'unfinished feature\n');
  const remoteSha = await advanceMain(f);
  const result = await syncMain({ repoPath: f.repoPath, repository: f.repository.slug });
  assert.equal(result.reason, 'not_main');
  assert.equal(result.remoteSha, remoteSha);
  assert.equal(await git(f.repoPath, ['symbolic-ref', '--short', 'HEAD']), 'feature/active');
  assert.equal(await git(f.repoPath, ['rev-parse', 'refs/heads/main']), f.baseSha);
  assert.equal(await git(f.repoPath, ['rev-parse', 'HEAD']), f.baseSha);
  assert.equal(await readFile(join(f.repoPath, 'draft.txt'), 'utf8'), 'unfinished feature\n');
});

test('main sync skips an in-progress merge and rejects a mismatched origin', async (t) => {
  const f = await fixture(t);
  await advanceMain(f);
  const mergeHead = join(f.repoPath, await git(f.repoPath, ['rev-parse', '--git-path', 'MERGE_HEAD']));
  await writeFile(mergeHead, f.baseSha+'\n');
  assert.equal((await syncMain({ repoPath: f.repoPath, repository: f.repository.slug })).reason, 'operation_in_progress');
  assert.equal(await git(f.repoPath, ['rev-parse', 'HEAD']), f.baseSha);
  await assert.rejects(syncMain({ repoPath: f.repoPath, repository: 'other/project' }), /Origin does not match/);
});


test('main sync refuses to overwrite ignored local files that become tracked remotely', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repoPath, '.git', 'info', 'exclude'), 'merged.txt\n');
  await writeFile(join(f.repoPath, 'merged.txt'), 'private ignored contents\n');
  assert.equal(await git(f.repoPath, ['status', '--porcelain=v1']), '');
  await advanceMain(f);
  await assert.rejects(syncMain({ repoPath: f.repoPath, repository: f.repository.slug }), /git merge failed/);
  assert.equal(await git(f.repoPath, ['rev-parse', 'HEAD']), f.baseSha);
  assert.equal(await readFile(join(f.repoPath, 'merged.txt'), 'utf8'), 'private ignored contents\n');
});

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
test('MCP sync follows notifications from a dirty feature worktree without moving that branch', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await prepareWorktree(f);
  await writeFile(join(f.worktreePath, 'draft.txt'), 'unfinished work\n');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const results = [];
  const cursors = [];
  const errors = [];
  let remoteSha;
  const before = (await f.commands()).filter(({ args }) => args.includes('fetch')).length;
  const api = {
    repositories: async () => {
      assert.equal((await f.commands()).filter(({ args }) => args.includes('fetch')).length, before);
      return { repositories: [{ slug: 'test/project', lastEventSequence: 7 }] };
    },
    events: async (clanId, cursor) => {
      assert.equal(clanId, 'test-clan');
      cursors.push(cursor);
      if (cursor === 7) {
        remoteSha = await advanceMain(f);
        return { events: [{ sequence: 8, type: 'repository.main_changed', resourceId: 'test/project' }], nextCursor: 8 };
      }
      controller.abort();
      return { events: [], nextCursor: cursor };
    },
  };
  await runMcpSync(api, 'test-clan', { repoPath: f.worktreePath, signal: controller.signal,
    pollIntervalMs: 10, fallbackIntervalMs: 60000, onResult: (value) => results.push(value), onError: (error) => errors.push(error) });
  assert.deepEqual(errors, []);
  assert.deepEqual(cursors, [7, 8]);
  assert.deepEqual(results.map((value) => value.status), ['unchanged', 'updated']);
  assert.equal(await git(f.repoPath, ['rev-parse', 'HEAD']), remoteSha);
  assert.equal(await git(f.worktreePath, ['rev-parse', 'HEAD']), f.baseSha);
  assert.equal(await readFile(join(f.worktreePath, 'draft.txt'), 'utf8'), 'unfinished work\n');
  assert.equal((await f.commands()).filter(({ args }) => args.includes('fetch')).length, before + 2);
});

test('automatic sync reports a non-project directory without fetching or polling', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const errors = [];
  await runMcpSync({ repositories: () => assert.fail('No clan request without a repository') }, 'test-clan', {
    repoPath: f.root, signal: controller.signal,
    onResult: () => assert.fail('No sync result outside a repository'), onError: (error) => errors.push(error),
  });
  assert.equal(errors.length, 1);
  assert.equal((await f.commands()).filter(({ args }) => args.includes('fetch')).length, 0);
});

test('MCP automatically catches up main and stops syncing on stdin close or SIGTERM', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await prepareWorktree(f);
  const remoteSha = await advanceMain(f);
  const clanId = '84367b51-14c7-43de-84a1-faf0207eadb3';
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/me') response.end(JSON.stringify({ id: clanId, email: 'test@example.com', clanId }));
    else if (request.url.endsWith('/repositories')) response.end(JSON.stringify({ repositories: [] }));
    else if (request.url.includes('/events')) response.end(JSON.stringify({ events: [], nextCursor: 0 }));
    else if (request.url === '/health') response.end(JSON.stringify({ status: 'ok', service: 'clqn-api', version: '0.1.0' }));
    else { response.writeHead(404); response.end('{}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const mode of ['stdin', 'signal']) {
    const before = (await f.commands()).filter(({ args }) => args.includes('fetch')).length;
    const child = spawn(process.execPath, [cli, '--api-url', `http://127.0.0.1:${server.address().port}`, 'mcp',
      ...(mode === 'stdin' ? ['--path', f.worktreePath] : [])], {
      cwd: mode === 'stdin' ? f.root : f.worktreePath,
      env: { ...process.env, CLQN_TOKEN: 'test-token', CLQN_CLAN_ID: clanId }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await closed; });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.resume();
    const deadline = Date.now() + 8000;
    while ((await f.commands()).filter(({ args }) => args.includes('fetch')).length <= before
      || await git(f.repoPath, ['rev-parse', 'HEAD']) !== remoteSha) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error('MCP did not sync main at startup');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await git(f.worktreePath, ['rev-parse', 'HEAD']), f.baseSha);
    if (mode === 'stdin') child.stdin.end();
    else child.kill('SIGTERM');
    const [code, signal] = await closed;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(stdout, '', 'sync diagnostics must not corrupt MCP stdout');
  }
});

test('code task defaults use the latest origin/main and a unique branch without modifying the checkout', async (t) => {
  const f = await fixture(t);
  const remoteSha = await advanceMain(f);
  await writeFile(join(f.repoPath, 'file.txt'), 'uncommitted personal edits\n');
  const first = await repositoryForNewTask(f.repoPath);
  const second = await repositoryForNewTask(f.repoPath);
  assert.equal(first.slug, 'test/project');
  assert.equal(first.baseBranch, 'main');
  assert.equal(first.baseSha, remoteSha);
  assert.match(first.branch, /^clqn\/task-[0-9a-f-]+$/);
  assert.notEqual(first.branch, second.branch);
  assert.equal(await git(f.repoPath, ['rev-parse', 'HEAD']), f.baseSha);
  assert.equal(await readFile(join(f.repoPath, 'file.txt'), 'utf8'), 'uncommitted personal edits\n');
});

test('automatic task directories can resume the same dirty worktree without creating another branch', async (t) => {
  const f = await fixture(t);
  const taskId = '712144c8-1638-4217-bbb1-8db77df3ae49';
  const location = await taskWorktreeLocation({ repoPath: f.repoPath, taskId, repository: f.repository });
  assert.equal(location.worktreePath, join(f.root, 'personal-712144c8'));
  const prepared = await openTaskWorktree({ ...location, repository: f.repository });
  await writeFile(join(prepared.path, 'draft.txt'), 'active work\n');
  const resumedLocation = await taskWorktreeLocation({ repoPath: prepared.path, taskId, repository: f.repository });
  assert.equal(resumedLocation.worktreePath, prepared.path);
  assert.deepEqual(await openTaskWorktree({ ...resumedLocation, repository: f.repository }), prepared);
  assert.equal(await readFile(join(prepared.path, 'draft.txt'), 'utf8'), 'active work\n');
  await assert.rejects(openTaskWorktree({ repoPath: f.repoPath, worktreePath: f.repoPath, repository: f.repository }), /different branch/);
  await assert.rejects(taskWorktreeLocation({ repoPath: f.repoPath, taskId, repository: { ...f.repository, slug: 'other/repo' } }), /Origin does not match/);
});
