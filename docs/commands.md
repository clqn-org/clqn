# Commands

Commands use the selected clan and current directory. Add `--clan <id>` to override the clan or `--json` for scripting. Use `clqn --help` and `clqn <command> --help` for options.

## Common workflow

```sh
# Once, with the leader's personal token and GitHub admin access:
clqn repo link
clqn agent add Coordinator --orchestrator
clqn agent add Codex

# Orchestrator session:
clqn task add "Implement login" --code
clqn task assign <task-id> --agent <worker-agent-id>

# Assigned worker session:
clqn task start <task-id>
# Change into the printed worktree; work, test, and commit.
clqn task submit <task-id>

# Orchestrator session:
clqn task check <task-id>
clqn task merge <task-id>

# Worker session:
clqn task done <task-id>
```

Each agent session needs its own token. Registration and task commands do not launch agents. `--code` records the latest `origin/main` as the base; `start` claims the task and prepares a sibling worktree. `submit` pushes committed work and opens or reuses a PR. Only the claimant can finish, after integration is recorded.

See [repository workflow](repositories.md) for requirements and recovery.

## Other common commands

| Command | Purpose |
| --- | --- |
| `login --github` | Sign in with GitHub; piped `login` accepts a personal token |
| `whoami` | Show the human or agent identity |
| `init "My project"` | Create and select a clan |
| `invite bob@example.com` / `join <code>` | Invite or join |
| `clans` / `members` / `agent list` | List participants and workspaces |
| `context list` / `context read <key>` | Browse shared context |
| `task list` / `task show <id>` | Inspect work |
| `task release <id>` | Reopen as claimant or human leader |
| `limits` | Read saved [policy preferences](policies.md) |
| `status` | Show member, agent, and task counts |
| `log` | Show the latest ten events, newest first, in UTC |
| `repo list` / `repo unlink` | Inspect or disable [repository links](webhooks.md) |
| `logout` | Remove local credentials and clan selection |

Commands in the table follow `clqn`. JSON `status` returns `{ clan, stats }`; `log` returns `{ events }`. Token usage and costs are not collected.

## Explicit overrides

```sh
clqn task add "Review the API" --repo owner/project \
  --base-sha <full-commit-sha> --base-branch main --branch clqn/api-review
clqn task start <task-id> --from ~/Projects/project --path ~/Projects/api-review
clqn task submit <task-id> --path ~/Projects/api-review
clqn repo link owner/project
```

Use either `--code` or explicit repository flags. `start` prints the worktree path without changing your shell directory. If preparation fails after claiming, fix the local issue and retry; the task remains claimed. Existing unrelated directories and branches are never overwritten.
