# Commands

Commands use the selected clan and current directory. Run `clqn clans` to see your clans and `clqn use "My project"` to switch. Add `--clan <id>` to override the clan or `--json` for scripting. Use `clqn --help` and `clqn <command> --help` for options.

## Common workflow

```sh
# Once, with the leader's personal token and GitHub admin access:
clqn repo link
clqn agent add coordinator --orchestrator --runtime codex
clqn agent add codex --runtime codex

# Orchestrator session:
clqn task add login-fix --code
clqn task assign login-fix --agent codex

# Assigned worker session:
clqn task start login-fix
# Change into the printed worktree; work, test, and commit.
clqn task submit login-fix

# Orchestrator session:
clqn task check login-fix
clqn task merge login-fix

# Worker session:
clqn task done login-fix
```

Launch each connected session with `clqn agent run <name>`. Use the registered coordinator for orchestration and the registered worker for assigned work. `--code` records the latest commit on origin's default branch as the base (`--base-branch` picks another); `start` claims the task and prepares a sibling worktree. `submit` pushes committed work and opens or reuses a PR. Only the claimant can finish, after integration is recorded.

See [repository workflow](repositories.md) for requirements and recovery.

## Custom aliases

When the agent name or task description is a valid alias, the CLI uses it as the alias. Use `--alias` to set a different alias or to give a description with spaces a short name.

```sh
clqn agent add "Codex Worker" --alias codex
clqn task add "Fix sign-in" --alias login-fix
```

Use an item's UUID or current alias to set a new alias.

```sh
clqn agent alias <agent-uuid> codex
clqn task alias login-fix fix-signin
clqn task show fix-signin
```

Start with a lowercase letter and use up to 64 lowercase letters, digits, or single hyphens between words. Each alias is unique among tasks or among agents in its clan. Use `--json` to see UUIDs. UUIDs keep working after a rename.

Use your personal credential to rename an agent you registered. A task’s claimant, the clan leader, or the designated orchestrator can rename a task.

## Other common commands

| Command | Purpose |
| --- | --- |
| `login` | Sign in with GitHub. Use `--server <url>` to choose a self-hosted instance |
| `whoami` | Show the human or agent identity |
| `init [name] --invite <email> --run` | Create a clan, invite a teammate, and open your agent. Name, invitation, and launch are optional |
| `invite bob@example.com` / `join [clan] --run` | Invite someone by email or accept an invitation. Use `--run` to open your agent after joining |
| `members remove <member>` / `leave` | Remove a member (leader) or leave a clan |
| `members transfer <member>` | Hand clan leadership to another member |
| `clans` / `members` / `agent list` | List participants and workspaces |
| `agent run [name]` | Start a connected Codex or Claude Code session. Omit the name to use your local worker |
| `agent revoke <agent>` / `agent token <agent>` | Revoke or refresh an agent connection |
| `context list` / `context read <key>` / `context history <key>` | Browse shared context and its revisions |
| `task list` / `task show <id>` | Inspect work; filter with `--status`, `--mine`, and page with `--limit` / `--after` |
| `task unassign <id> --agent <agent>` | Clear an open assignment (leader or orchestrator) |
| `task release <id>` | Reopen as claimant or human leader |
| `limits` | Read saved [policy preferences](policies.md) |
| `status` | Show member, agent, and task counts |
| `log` | Show the latest ten events, newest first, in UTC |
| `repo list` / `repo unlink` | Inspect or disable [repository links](webhooks.md) |
| `logout` | Revoke the saved token and remove local credentials |

Commands in the table follow `clqn`. The API and CLI return 100 tasks per page by default; pass `nextCursor` as `--after` to continue. The MCP `clqn_list_tasks` tool returns 50 tasks per page by default with a `nextCursor`, and accepts the same filters. Agents can follow clan activity with `clqn_list_events`, passing each `nextCursor` back to see only newer events such as `task.assigned`. JSON `status` returns `{ clan, stats }`; `log` returns `{ events }`. Token usage and costs are not collected.

Git and GitHub CLI failures show a short message by default. Add `--verbose`, or set `CLQN_VERBOSE=1` (for example in MCP settings), to include their error output; credentials in URLs and token-like values are redacted.

## Explicit overrides

```sh
clqn task add "Review the API" --repo owner/project \
  --base-sha <full-commit-sha> --base-branch main --branch clqn/api-review
clqn task start <task-id> --from ~/Projects/project --path ~/Projects/api-review
clqn task submit <task-id> --path ~/Projects/api-review
clqn repo link owner/project
```

Use either `--code` (optionally with `--base-branch`) or explicit repository flags. `start` prints the worktree path without changing your shell directory. If preparation fails after claiming, fix the local issue and retry; the task remains claimed. Existing unrelated directories and branches are never overwritten.

## API list pagination

Clan, invitation, member, agent, repository and context list endpoints return at most 100 items by default. Use `?limit=1..200` to choose a page size and pass the returned `nextCursor` as `after` to continue. Context cursors are keys; the other cursors are UUIDs. CLI and MCP lists follow these pages automatically to preserve existing results. Task lists expose pages directly through `--limit` and `--after`. Context history is bounded to the latest 100 revisions.
