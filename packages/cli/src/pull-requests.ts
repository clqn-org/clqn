import type { ChatMergeRequest, ChatState, ClqnClient, TaskRepository } from '@clqn/shared';
import type { Frame } from './chat-view.js';
import { mergePullRequest } from './git.js';
import { clip, painter, plain } from './text.js';

interface PullRequest extends ChatMergeRequest {
  repository: TaskRepository & { headSha: string; prNumber: number };
  inMergeQueue: boolean;
  canReview: boolean;
}

export function chatPullRequests(state: ChatState | undefined): PullRequest[] {
  const requests = new Map<string, PullRequest>();
  function add(taskId: string, title: string, repository: TaskRepository | null | undefined, inMergeQueue: boolean) {
    if (requests.has(taskId) || !repository?.headSha || !repository.prNumber) return;
    const { headSha, prNumber } = repository;
    requests.set(taskId, {
      taskId,
      title,
      repository: { ...repository, headSha, prNumber },
      inMergeQueue,
      canReview: inMergeQueue && repository.state === 'open' && repository.mergeApproval?.headSha !== headSha,
    });
  }
  for (const { taskId, title, repository } of state?.mergeQueue ?? []) {
    add(taskId, title, repository, true);
  }
  for (const { taskId, title, repository } of state?.runs ?? []) add(taskId, title, repository, false);
  return [...requests.values()];
}

export const pullRequestKey = ({ taskId, repository }: PullRequest) => `${taskId}:${repository.headSha}`;

export function pullRequestStatus(repository: TaskRepository, leader = false) {
  if (repository.state === 'merged') return 'Merged';
  if (repository.state !== 'open') return 'Publishing';
  if (repository.mergeApproval?.headSha === repository.headSha)
    return repository.mergeApproval?.approved ? 'Approved · waiting for merge' : 'Merge declined';
  return leader ? 'Awaiting your merge approval' : 'Awaiting clan leader approval';
}

export function pullRequestsFrame(view: {
  columns: number;
  rows: number;
  color: boolean;
  links: boolean;
  clan: string;
  requests: PullRequest[];
  selected?: string | undefined;
  status?: string | undefined;
  notice?: string | undefined;
}): Frame {
  const { columns, rows } = view;
  if (columns < 28 || rows < 12) return { lines: [clip('Enlarge terminal · Ctrl+C to quit', columns)] };
  const paint = painter(view.color);
  const index = view.requests.findIndex((request) => pullRequestKey(request) === view.selected);
  const request = view.requests[index];
  const line = (value: string) => clip(plain(value), columns);
  const header = line(`◆ clqn / ${view.clan} · Pull requests`);
  const lines = [
    paint(header.slice(0, 6), 'accent') + paint(header.slice(6), 'bold'),
    paint('─'.repeat(columns), 'muted'),
  ];
  if (request) {
    const { repository } = request;
    const url = `https://github.com/${repository.slug}/pull/${repository.prNumber}`;
    const label = line(url);
    lines.push(
      line(`#${repository.prNumber} · ${index + 1} of ${view.requests.length}`),
      paint(line(request.title), 'bold'),
      paint(line(view.status ?? pullRequestStatus(repository, request.canReview)), 'accent'),
      line(`Commit ${repository.headSha.slice(0, 12)}`),
      line(`Base ${repository.baseBranch}`),
      paint(view.links ? `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\` : label, 'accent'),
    );
  } else {
    lines.push(view.requests.length ? 'List changed · ↑↓ Choose' : 'No pull requests yet');
  }
  lines.push(
    view.notice ? paint(line(view.notice), 'warning') : '',
    request?.canReview ? paint(line('Y Approve merge · N Decline'), 'warning') : '',
    paint(line('↑↓ Choose · Esc Back'), 'muted'),
  );
  return { lines };
}

// The server retains approvals across sessions. GitHub operations use the current leader's own GitHub CLI login.
export function chatMerger(
  api: Pick<ClqnClient, 'chatInfo' | 'task' | 'repositories' | 'integrateTask'>,
  clanId: string,
  signal: AbortSignal,
  merge = mergePullRequest,
) {
  const attempts = new Map<string, { at: number; status: string }>();
  let checking = false;
  async function check(request: PullRequest, key: string) {
    const { taskId, repository } = request;
    const { headSha, prNumber } = repository;
    checking = true;
    attempts.set(key, { at: Date.now(), status: 'Checking GitHub…' });
    let status: string;
    try {
      const result = await merge({
        repository,
        prNumber,
        headSha,
        waitForChecks: true,
        defaultBranchOnly: true,
        signal,
        async beforeMerge() {
          const [info, task, links] = await Promise.all([
            api.chatInfo(clanId, signal),
            api.task(clanId, taskId, signal),
            api.repositories(clanId, signal),
          ]);
          const current = task.repository;
          if (
            !info.canStart ||
            task.status !== 'claimed' ||
            current?.state !== 'open' ||
            current.slug !== repository.slug ||
            current.branch !== repository.branch ||
            current.baseBranch !== repository.baseBranch ||
            current.prNumber !== prNumber ||
            current.headSha !== headSha ||
            current.mergeApproval?.headSha !== headSha ||
            !current.mergeApproval.approved ||
            !links.repositories.some(({ slug }) => slug === repository.slug)
          )
            throw new Error('The clan approval or pull request changed');
          signal.throwIfAborted();
        },
      });
      if (result.mergeCommitSha && result.state === 'MERGED') {
        const task = await api.integrateTask(
          clanId,
          taskId,
          { headSha, mergeCommitSha: result.mergeCommitSha },
          signal,
        );
        status = task.repository?.state === 'merged' ? 'Merged' : 'Merged on GitHub · waiting for webhook';
      } else if (!result.checksPassed) {
        status = result.checksReported ? 'Waiting for checks to pass' : 'Waiting for a successful check';
      } else {
        status = 'Waiting for GitHub to finish merging';
      }
    } catch (error) {
      status = error instanceof Error ? error.message : 'Could not check or merge this pull request';
    } finally {
      checking = false;
    }
    attempts.set(key, { at: Date.now(), status });
  }

  return {
    update(requests: PullRequest[]) {
      if (checking || signal.aborted) return;
      const current = new Set(requests.map(pullRequestKey));
      for (const key of attempts.keys()) if (!current.has(key)) attempts.delete(key);
      const checkedAt = (request: PullRequest) => attempts.get(pullRequestKey(request))?.at ?? 0;
      const next = requests
        .filter(
          ({ inMergeQueue, repository }) =>
            inMergeQueue &&
            repository.state === 'open' &&
            repository.mergeApproval?.approved &&
            repository.mergeApproval.headSha === repository.headSha,
        )
        .sort((a, b) => checkedAt(a) - checkedAt(b))
        .find((request) => Date.now() - checkedAt(request) >= 30_000);
      if (next) void check(next, pullRequestKey(next));
    },
    status: (key: string | undefined) => (key ? attempts.get(key)?.status : undefined),
  };
}
