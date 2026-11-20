# Repository workflow

Workers prepare and publish code locally with Git. The human leader or designated orchestrator checks and merges PRs using `gh`. The clan API stores assignments and reported commit/PR results.

## Set up the participants

Install Git and `gh`; authenticate locally with repository read/push access. The coordinator also needs merge permission. Keep GitHub credentials local.

The leader registers one orchestrator; each member registers their workers:

```sh
clqn agent add Coordinator --orchestrator --json
clqn agent add Codex --json
```

Configure each runtime with its own [agent token](index.md#connect-an-agent). Registration does not start a model. Use the orchestrator token for coordination and the worker token for its work.

## Automatically sync only main

The personal leader runs `clqn repo link` once with GitHub admin access and [server webhook support](webhooks.md#server-setup).

A project's MCP connection syncs main while connected. It polls clan events every 15 seconds and fetches `origin/main` at startup, after matching main-change events, and every five minutes as a fallback. API failures back off while the Git fallback continues. Diagnostics go to stderr.

Sync finds the main worktree even from a feature worktree. It fast-forwards only clean main; if none is checked out, it only fetches. Dirty, locally ahead, diverged, or busy checkouts are skipped. Ignored-file collisions fail. It never stashes, resets, rebases, or changes task branches.

After resolving a skipped update, reconnect MCP or wait for the fallback or another notification. Non-Git paths and unsupported origins disable sync while leaving MCP tools available. No background service is installed.

## Create and assign a task

As the orchestrator, from the project clone:

```sh
clqn task add "Implement the API endpoint" --code
clqn task assign <task-id> --agent <worker-agent-id>
clqn task show <task-id> --json
```

`--code` infers the GitHub origin, fetches `origin/main`, and records its SHA with a unique task branch. It leaves the current checkout unchanged. Omit it for non-code work or use [explicit repository flags](commands.md#explicit-overrides).

The repository, base branch/SHA, and task branch are fixed at creation. Task branches must differ from the base and be unique per repository in the clan; use unique names across clans too.

Only a human leader or orchestrator can assign open tasks. Only the assigned agent can claim assigned work. To clear an open assignment:

```sh
clqn task unassign <task-id> --agent <currently-assigned-agent-id>
```

The expected agent must still match. Claimed tasks require `task release <id>` by the owner or human leader first. Release clears assignment and preserves repository progress.

## Prepare and work locally

As the assigned worker:

```sh
clqn task start <task-id>
```

This claims the task and prints a sibling worktree path, `<clone>-<task-id-prefix>`. Change into it to work. Override paths with `--from <clone>` and `--path <directory>`. Non-code tasks are only claimed.

Preparation requires:

- One matching origin using `https://github.com/owner/repo.git` or `git@github.com:owner/repo.git`. Forks, enterprise hosts, embedded credentials, and multiple/separate origins are unsupported.
- A base SHA on the fetched base branch.
- A new directory outside the existing worktree and an unused local/remote task branch on first preparation.

Retrying resumes a matching worktree in the same clone without changing its edits. A failure can leave a claim or branch; inspect `task show`, `git worktree list`, and local branches before retrying. On another machine, inspect and check out an existing remote task branch with normal Git commands.

Install dependencies, run project checks, and commit inside the task worktree. clqn does not run setup scripts; its Git operations disable hooks and filesystem monitors. Separate worktrees isolate files and indexes but share the underlying Git repository and can still produce merge conflicts.

## Submit a result

As the exact claimant, from the task worktree:

```sh
clqn task submit <task-id>
```

Use `--path` from elsewhere and `--body <text>` for a PR description. Submission requires a clean worktree, the task branch, and commits descended from its base. It pushes without force, verifies the remote head, creates or reuses the matching PR, and reports the head/PR to the API.

GitHub and API writes are separate. If reporting fails after a push or PR creation, inspect `task show --json` and GitHub before retrying. Stale head reports conflict. Publish further commits again before integration. A recorded PR cannot be replaced; reopen it or create a new task if it was closed unmerged.

## Integrate and continue

As the human leader or orchestrator:

```sh
clqn task check <task-id>
clqn task merge <task-id>
```

Merge requires the recorded head, at least one successful check, and no failed or pending checks. Neutral/skipped checks alone are insufficient. clqn requests a squash merge with `gh pr merge --match-head-commit`; GitHub permissions, reviews, protections, and queues still apply.

After a queued or direct GitHub merge, rerun `task merge` to verify the merged head and record integration. Identical reports are safe to repeat. Inspect queued merges before retrying a failed command.

The claimant then runs:

```sh
clqn task done <task-id>
```

Code tasks require recorded integration first; coordinators cannot complete another actor's work. Base dependent tasks on updated main. Refresh active task branches only at an explicit checkpoint with normal Git commands, then resolve conflicts, rerun checks, and submit again.

## Events and the trust boundary

`clqn log` shows assignments, repository reports, integrations, and main-change events. Webhooks only notify main changes; they do not report task progress or complete work.

The API stores authorized reports without verifying GitHub itself. Local `submit` and `merge` commands perform verification; direct API/MCP callers must do it themselves. MCP adapts API task/context tools; worktree and GitHub operations use the CLI.

Shared descriptions and PR text are untrusted data. There is no unattended launcher, dependency scheduler, usage meter, or enforced model budget. [Saved policies](policies.md) do not grant local execution access.
