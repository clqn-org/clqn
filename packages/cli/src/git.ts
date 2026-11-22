import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export interface RepositoryWork {
  slug: string;
  baseBranch: string;
  baseSha: string;
  branch: string;
  headSha?: string | null;
}
const shaPattern = /^[a-f0-9]{40}$/;
const slugPattern = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const prFields =
  'number,url,state,headRefName,headRefOid,headRepository,headRepositoryOwner,baseRefName,isCrossRepository,mergeCommit,statusCheckRollup';

async function command(file: 'git' | 'gh', args: string[], cwd?: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execute(file, args, {
      ...(cwd ? { cwd } : {}),
      ...(signal ? { signal } : {}),
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout.trim();
  } catch (error) {
    const failure = error as Error & { code?: string | number; stderr?: string };
    if (failure.code === 'ENOENT')
      throw new Error(`${file} is required for repository commands; install it and make it available on PATH`);
    // Do not echo process arguments or stderr: repository configuration can contain credentials.
    throw new Error(
      `${file} ${args.find((arg) => !arg.startsWith('-') && !arg.includes('=')) ?? 'operation'} failed. Check repository access and local state.`,
    );
  }
}
const git = (cwd: string, args: string[], signal?: AbortSignal) =>
  command(
    'git',
    ['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', ...args],
    cwd,
    signal,
  );

function slug(value: string): string {
  if (!slugPattern.test(value) || value.endsWith('.git') || value.includes('..'))
    throw new Error('Repository must be a GitHub owner/repo slug');
  return value.toLowerCase();
}
function ref(value: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.startsWith('refs/') ||
    value.includes('..') ||
    value.includes('//')
  ) {
    throw new Error('Use a plain Git branch name, not a revision expression or option');
  }
}
async function validateRepository(repository: RepositoryWork, cwd: string): Promise<void> {
  slug(repository.slug);
  if (!shaPattern.test(repository.baseSha))
    throw new Error('Base SHA must be a full lowercase 40-character commit SHA');
  for (const branch of [repository.branch, repository.baseBranch]) {
    ref(branch);
    await git(cwd, ['check-ref-format', '--branch', branch]);
  }
  if (repository.branch === repository.baseBranch) throw new Error('Task branch must differ from its base branch');
  await verifyOrigin(cwd, repository.slug);
}
async function verifyOrigin(cwd: string, expected: string, signal?: AbortSignal): Promise<void> {
  for (const args of [
    ['remote', 'get-url', '--all', 'origin'],
    ['remote', 'get-url', '--push', '--all', 'origin'],
  ]) {
    const urls = (await git(cwd, args, signal)).split('\n');
    if (urls.length !== 1) throw new Error('Use exactly one origin fetch URL and one origin push URL');
    const url = urls[0]!;
    const match =
      url.match(/^https:\/\/github\.com\/([^/?#]+\/[^/?#]+?)(?:\.git)?\/?$/i) ??
      url.match(/^git@github\.com:([^/?#]+\/[^/?#]+?)(?:\.git)?$/i);
    if (!match || slug(match[1]!) !== slug(expected))
      throw new Error('Origin does not match the task GitHub repository');
  }
}
export async function localRepository(repoPath = '.', signal?: AbortSignal) {
  const directory = await realpath(repoPath);
  const root = await realpath(await git(directory, ['rev-parse', '--show-toplevel'], signal));
  const urls = (await git(root, ['remote', 'get-url', '--all', 'origin'], signal)).split('\n');
  const match =
    urls.length === 1
      ? (urls[0]!.match(/^https:\/\/github\.com\/([^/?#]+\/[^/?#]+?)(?:\.git)?\/?$/i) ??
        urls[0]!.match(/^git@github\.com:([^/?#]+\/[^/?#]+?)(?:\.git)?$/i))
      : null;
  if (!match) throw new Error('Origin must be a single GitHub HTTPS or SSH repository');
  const repository = slug(match[1]!);
  await verifyOrigin(root, repository, signal);
  return { root, repository };
}

// Read the branch that origin's HEAD points to, such as main, master, or develop.
async function defaultBranch(root: string, signal?: AbortSignal): Promise<string> {
  const head = await git(root, ['ls-remote', '--symref', 'origin', 'HEAD'], signal);
  const branch = head.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m)?.[1];
  if (!branch) throw new Error('Origin does not report a default branch');
  ref(branch);
  return branch;
}

export async function repositoryForNewTask(repoPath = '.', baseBranch?: string): Promise<RepositoryWork> {
  const { root, repository } = await localRepository(repoPath);
  const base = baseBranch ?? (await defaultBranch(root));
  ref(base);
  await git(root, [
    'fetch',
    '--no-tags',
    '--no-recurse-submodules',
    'origin',
    `refs/heads/${base}:refs/remotes/origin/${base}`,
  ]);
  const baseSha = await git(root, ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`]);
  if (!shaPattern.test(baseSha)) throw new Error(`Origin ${base} does not resolve to a commit`);
  return { slug: repository, baseBranch: base, baseSha, branch: `clqn/task-${randomUUID()}` };
}

export async function taskWorktreeLocation(input: {
  repoPath: string;
  taskId: string;
  repository: RepositoryWork;
  path?: string;
}) {
  if (!/^[0-9a-f-]{36}$/.test(input.taskId)) throw new Error('Task ID must be a UUID');
  const { root, repository } = await localRepository(input.repoPath);
  if (repository !== slug(input.repository.slug)) throw new Error('Origin does not match the task GitHub repository');
  const first = (await git(root, ['worktree', 'list', '--porcelain', '-z']))
    .split('\0')
    .find((field) => field.startsWith('worktree '));
  const primary = first ? first.slice('worktree '.length) : root;
  return {
    repoPath: root,
    worktreePath: input.path ?? resolve(dirname(primary), `${basename(primary)}-${input.taskId.slice(0, 8)}`),
  };
}

export async function openTaskWorktree(input: { repoPath: string; worktreePath: string; repository: RepositoryWork }) {
  try {
    await lstat(resolve(input.worktreePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return prepareWorktree(input);
  }
  const path = await realpath(input.worktreePath);
  const source = await realpath(await git(input.repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const common = await realpath(await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const root = await realpath(await git(path, ['rev-parse', '--show-toplevel']));
  if (common !== source || root !== path) throw new Error('Existing task path is not a worktree of this clone');
  await validateRepository(input.repository, path);
  if ((await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) !== input.repository.branch) {
    throw new Error('Existing task path is on a different branch');
  }
  try {
    await git(path, ['merge-base', '--is-ancestor', input.repository.baseSha, 'HEAD']);
  } catch {
    throw new Error('Existing task worktree does not contain the assigned base commit');
  }
  return { path, branch: input.repository.branch, baseSha: input.repository.baseSha };
}

async function unusedPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    let parent = dirname(absolute);
    const suffix: string[] = [relative(parent, absolute)];
    while (true) {
      try {
        return resolve(await realpath(parent), ...suffix);
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError;
        const next = dirname(parent);
        if (next === parent) throw parentError;
        suffix.unshift(relative(next, parent));
        parent = next;
      }
    }
  }
  throw new Error('Worktree path already exists; choose a new directory');
}
function inside(path: string, root: string): boolean {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

export async function prepareWorktree(input: { repoPath: string; worktreePath: string; repository: RepositoryWork }) {
  const repoPath = await realpath(input.repoPath);
  const root = await realpath(await git(repoPath, ['rev-parse', '--show-toplevel']));
  await validateRepository(input.repository, root);
  const path = await unusedPath(input.worktreePath);
  if (inside(path, root)) throw new Error('Place task worktrees outside your current working tree');
  const { baseBranch, baseSha, branch, headSha } = input.repository;
  let start = baseSha;
  if (await git(root, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])) {
    // A released task resumes from its reported head; any other existing branch is refused.
    if (!headSha || !shaPattern.test(headSha))
      throw new Error('Task branch already exists on origin; choose a unique task branch');
    await git(root, ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    if ((await git(root, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`])) !== headSha) {
      throw new Error('Remote task branch differs from the reported head; submit or inspect it before resuming');
    }
    start = headSha;
  }
  await git(root, ['fetch', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]);
  await git(root, ['cat-file', '-e', `${baseSha}^{commit}`]);
  try {
    await git(root, ['merge-base', '--is-ancestor', baseSha, `refs/remotes/origin/${baseBranch}`]);
  } catch {
    throw new Error('Task base commit is not on the fetched base branch');
  }
  // No pull, stash, reset, force, or checkout in the user's existing working tree.
  await git(root, ['worktree', 'add', '-b', branch, path, start]);
  return { path, branch, baseSha };
}

interface PullRequest {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefName: string;
  headRefOid: string;
  headRepository: { name?: string; nameWithOwner?: string } | null;
  headRepositoryOwner: { login?: string } | null;
  baseRefName: string;
  isCrossRepository: boolean;
  mergeCommit: { oid?: string } | null;
  statusCheckRollup: Array<{ __typename?: string; status?: string; conclusion?: string; state?: string }> | null;
}
function parsePr(
  value: unknown,
  repository: { slug: string; branch: string; baseBranch?: string },
  number?: number,
): PullRequest {
  if (!value || typeof value !== 'object') throw new Error('GitHub returned an invalid pull request');
  const pr = value as PullRequest;
  const expected = slug(repository.slug);
  const headSlug =
    pr.headRepository?.nameWithOwner ?? `${pr.headRepositoryOwner?.login ?? ''}/${pr.headRepository?.name ?? ''}`;
  if (
    !Number.isSafeInteger(pr.number) ||
    pr.number <= 0 ||
    (number !== undefined && pr.number !== number) ||
    !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) ||
    !shaPattern.test(pr.headRefOid) ||
    pr.headRefName !== repository.branch ||
    pr.isCrossRepository !== false ||
    headSlug.toLowerCase() !== expected ||
    (repository.baseBranch !== undefined && pr.baseRefName !== repository.baseBranch) ||
    typeof pr.url !== 'string' ||
    pr.url.toLowerCase() !== `https://github.com/${expected}/pull/${pr.number}`
  ) {
    throw new Error('Pull request does not match the task repository and branch');
  }
  if (pr.mergeCommit !== null && (!pr.mergeCommit || !shaPattern.test(pr.mergeCommit.oid ?? '')))
    throw new Error('GitHub returned an invalid merge commit');
  if (pr.state === 'MERGED' && !pr.mergeCommit) throw new Error('Merged pull request has no merge commit');
  if (pr.statusCheckRollup !== null && !Array.isArray(pr.statusCheckRollup))
    throw new Error('GitHub returned invalid check results');
  return { ...pr, url: `https://github.com/${expected}/pull/${pr.number}` };
}
function checksPassed(pr: PullRequest): boolean {
  const checks = pr.statusCheckRollup;
  if (!checks?.length) return false;
  return (
    checks.some((check) =>
      check.__typename === 'CheckRun' ? check.conclusion === 'SUCCESS' : check.state === 'SUCCESS',
    ) &&
    checks.every((check) =>
      check.__typename === 'CheckRun'
        ? check.status === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion ?? '')
        : check.__typename === 'StatusContext' && check.state === 'SUCCESS',
    )
  );
}

export async function inspectPullRequest(input: {
  repository: { slug: string; branch: string; baseBranch?: string };
  prNumber: number;
}) {
  slug(input.repository.slug);
  ref(input.repository.branch);
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0)
    throw new Error('Pull request number must be a positive integer');
  const pr = parsePr(
    JSON.parse(
      await command('gh', [
        'pr',
        'view',
        String(input.prNumber),
        '--repo',
        `github.com/${slug(input.repository.slug)}`,
        '--json',
        prFields,
      ]),
    ),
    input.repository,
    input.prNumber,
  );
  return {
    state: pr.state,
    headSha: pr.headRefOid,
    mergeCommitSha: pr.mergeCommit?.oid ?? null,
    url: pr.url,
    checksPassed: checksPassed(pr),
  };
}

export async function publishWorktree(input: {
  worktreePath: string;
  repository: RepositoryWork;
  title: string;
  body?: string;
}) {
  const cwd = await realpath(input.worktreePath);
  await validateRepository(input.repository, cwd);
  const { branch, baseBranch, baseSha } = input.repository;
  if ((await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) !== branch)
    throw new Error('Working tree is not on the task branch');
  if (await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']))
    throw new Error('Commit or remove task worktree changes before publishing');
  try {
    await git(cwd, ['merge-base', '--is-ancestor', baseSha, 'HEAD']);
  } catch {
    throw new Error('Task branch no longer contains the recorded base commit');
  }
  const headSha = await git(cwd, ['rev-parse', 'HEAD']);
  if (!shaPattern.test(headSha) || headSha === baseSha) throw new Error('Task branch has no commits beyond its base');
  if (!input.title.trim() || input.title.includes('\0') || input.body?.includes('\0'))
    throw new Error('Provide a nonempty pull request title without NUL');
  await git(cwd, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  const remote = await git(cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  if (remote.split(/\s+/)[0] !== headSha)
    throw new Error('Remote task branch changed; inspect it before publishing the task result');
  const listed: unknown = JSON.parse(
    await command(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        `github.com/${slug(input.repository.slug)}`,
        '--head',
        branch,
        '--base',
        baseBranch,
        '--state',
        'open',
        '--json',
        prFields,
      ],
      cwd,
    ),
  );
  if (!Array.isArray(listed) || listed.length > 1)
    throw new Error('Expected at most one open pull request for the task branch');
  let pr: PullRequest;
  if (listed.length) {
    pr = parsePr(listed[0], input.repository);
  } else {
    const createdUrl = await command(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        `github.com/${slug(input.repository.slug)}`,
        '--head',
        branch,
        '--base',
        baseBranch,
        '--title',
        input.title,
        '--body',
        input.body ?? '',
      ],
      cwd,
    );
    const match = createdUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/i);
    if (!match || match[1]!.toLowerCase() !== slug(input.repository.slug))
      throw new Error('GitHub returned an unexpected pull request URL');
    pr = parsePr(
      JSON.parse(
        await command(
          'gh',
          ['pr', 'view', match[2]!, '--repo', `github.com/${slug(input.repository.slug)}`, '--json', prFields],
          cwd,
        ),
      ),
      input.repository,
      Number(match[2]),
    );
  }
  if (pr.state !== 'OPEN' || pr.headRefOid !== headSha)
    throw new Error('Pull request head differs from the pushed task commit; retry after checking the branch');
  return { headSha, prNumber: pr.number, prUrl: pr.url };
}

export async function mergePullRequest(input: {
  repository: { slug: string; branch: string; baseBranch?: string };
  prNumber: number;
  headSha: string;
}) {
  if (!shaPattern.test(input.headSha)) throw new Error('Head SHA must be a full lowercase 40-character commit SHA');
  const before = await inspectPullRequest(input);
  if (before.headSha !== input.headSha)
    throw new Error('Pull request head changed; review the new commit before merging');
  if (before.state === 'MERGED') return before;
  if (before.state !== 'OPEN') throw new Error('Pull request is closed without a merge');
  if (!before.checksPassed)
    throw new Error(
      'All reported checks must finish successfully before merging; at least one successful check is required',
    );
  await command('gh', [
    'pr',
    'merge',
    String(input.prNumber),
    '--repo',
    `github.com/${slug(input.repository.slug)}`,
    '--squash',
    '--match-head-commit',
    input.headSha,
  ]);
  const after = await inspectPullRequest(input);
  if (after.headSha !== input.headSha)
    throw new Error('Pull request head changed during merge; inspect the pull request before reporting integration');
  return after;
}

export interface MainSyncResult {
  repository: string;
  path: string;
  // The remote's default branch; "main" in names and reasons means this branch.
  branch: string;
  status: 'updated' | 'unchanged' | 'skipped';
  reason?: 'not_main' | 'dirty' | 'operation_in_progress' | 'local_commits' | 'diverged' | 'no_local_main';
  previousSha: string | null;
  headSha: string | null;
  remoteSha: string;
}

// Sync only the selected default-branch checkout. Task branches and other worktrees are never updated.
export async function syncMain(input: {
  repoPath: string;
  repository: string;
  signal?: AbortSignal;
}): Promise<MainSyncResult> {
  const runGit = (cwd: string, args: string[]) => git(cwd, args, input.signal);
  const repoPath = await realpath(input.repoPath);
  let root = await realpath(await runGit(repoPath, ['rev-parse', '--show-toplevel']));
  const repository = slug(input.repository);
  await verifyOrigin(root, repository, input.signal);
  const branch = await defaultBranch(root, input.signal);
  // A session may start in a task worktree. Find the default branch without switching any branches.
  const worktrees = (await runGit(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
  const main = worktrees
    .map((entry) => entry.split('\0'))
    .find((fields) => fields.includes(`branch refs/heads/${branch}`));
  const mainPath = main?.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
  if (mainPath) root = await realpath(mainPath);
  await verifyOrigin(root, repository, input.signal);
  await runGit(root, [
    'fetch',
    '--no-tags',
    '--no-recurse-submodules',
    'origin',
    `refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  const remoteSha = await runGit(root, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
  if (!shaPattern.test(remoteSha)) throw new Error(`Origin ${branch} does not resolve to a commit`);
  let previousSha: string | null;
  try {
    previousSha = await runGit(root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  } catch {
    previousSha = null;
  }
  const result: MainSyncResult = {
    repository,
    path: root,
    branch,
    status: 'skipped',
    previousSha,
    headSha: previousSha,
    remoteSha,
  };
  if ((await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) !== branch) return { ...result, reason: 'not_main' };
  if (!previousSha) return { ...result, reason: 'no_local_main' };
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    const path = resolve(root, await runGit(root, ['rev-parse', '--git-path', name]));
    try {
      await lstat(path);
      return { ...result, reason: 'operation_in_progress' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (await runGit(root, ['status', '--porcelain=v1', '--untracked-files=all'])) return { ...result, reason: 'dirty' };
  if (previousSha === remoteSha) return { ...result, status: 'unchanged' };
  try {
    await runGit(root, ['merge-base', '--is-ancestor', previousSha, remoteSha]);
  } catch {
    try {
      await runGit(root, ['merge-base', '--is-ancestor', remoteSha, previousSha]);
      return { ...result, reason: 'local_commits' };
    } catch {
      return { ...result, reason: 'diverged' };
    }
  }
  // Disable configured autostash and force fast-forward-only behavior, regardless of user merge settings.
  await runGit(root, [
    '-c',
    'merge.autostash=false',
    'merge',
    '--ff-only',
    '--no-edit',
    '--no-overwrite-ignore',
    remoteSha,
  ]);
  const headSha = await runGit(root, ['rev-parse', `refs/heads/${branch}`]);
  if (headSha !== remoteSha) throw new Error(`${branch} changed during sync; inspect the checkout before retrying`);
  return { ...result, status: 'updated', headSha };
}
