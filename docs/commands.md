# Commands

Use a short command for each common action. Commands use the selected clan and current directory unless you supply an override.

## Common workflow

```sh
# Once, as the clan leader with GitHub admin access:
clqn repo link

# On each machine: watch clan notifications and keep only main synced.
clqn sync --watch

# Register identities with your personal credential.
clqn agent add Coordinator --orchestrator
clqn agent add Codex

# In the orchestrator's session, from the project clone:
clqn task add "Implement login" --code
clqn task assign <task-id> --agent <worker-agent-id>

# In the worker's session, from the project clone:
clqn task start <task-id>
# Change into the printed worktree directory. Work, test, and commit there.
clqn task submit <task-id>

# In the orchestrator's session:
clqn task check <task-id>
clqn task merge <task-id>

# In the worker's session:
clqn task done <task-id>
```

Agent registration does not launch a model process. These examples assume each agent session uses its own token. `start` claims and opens work; it does not launch an agent or execute project setup scripts. `submit` pushes a committed task branch and creates or reuses its PR. `done` records task completion; code tasks still require recorded integration first.

`task add --code` infers origin, fetches the latest `origin/main`, and chooses a unique branch. `start` chooses a worktree directory beside the primary clone, named with the first eight characters of the task ID. It prints the path and can resume the same matching worktree without changing its existing edits. Change into that directory before submitting. The current shell directory is not changed by clqn.

## Other common commands

```sh
clqn login < /secure/path/to/token
clqn init "My project"
clqn invite bob@example.com
clqn join <invite-code>
clqn limits
clqn limits --tokens 100000 --models provider/model --control approve
clqn status
clqn stats
clqn watch
```

`limits` shows saved preferences with no options, or updates the fields you specify. `--tokens none` removes a cap; `--models any` removes the allowlist. These settings are not yet enforced by a model runner. `watch` observes clan events; `sync --watch` polls clan notifications and only fast-forwards clean main. Git is fetched at startup, after main notifications, and on a five-minute fallback. Without a clan login it uses the slower local Git fallback.

`stats` shows member and agent counts, task distribution bars, and completion percentage. `status` adds the clan name and latest ten activity events, with timestamps in UTC. These are workspace metrics; token usage and cost are not collected yet. Charts adapt to terminal width and remain readable when piped. Use `--clan <id>` to select another clan or `--json` for the unchanged API response without charts.

```text
TASKS / 20 total
Open      [########........................]  5  25%
Claimed   [#####...........................]  3  15%
Completed [###################.............] 12  60%

60% complete / 8 remaining
```

## Explicit overrides

```sh
# Sync a different checkout; origin is still inferred.
clqn sync --path ~/Projects/project --watch

# Assert the expected GitHub repository.
clqn sync --repo owner/project

# Set repository details yourself instead of using --code.
clqn task add "Review the API" --repo owner/project \
  --base-sha <full-commit-sha> --base-branch main --branch clqn/api-review

# Choose the source clone and task directory.
clqn task start <task-id> --from ~/Projects/project --path ~/Projects/api-review

# Submit without changing your shell directory.
clqn task submit <task-id> --path ~/Projects/api-review
```

Use either `--code` or explicit repository flags when creating a task. An initial `start` can fail after a successful claim, for example if fetching fails. The error reports that the task remains claimed; resolve the local problem and retry. An existing unrelated directory or branch is not overwritten. See [repository workflow](repositories.md) for recovery and GitHub requirements.

## GitHub notifications

```sh
clqn repo link                 # current origin, leader only
clqn repo list                 # selected clan's links
clqn repo unlink               # disable the current link and remove its GitHub hook
clqn sync --watch              # 15-second clan event checks, five-minute Git fallback
clqn sync --watch --fallback 600
```

`repo link owner/project` and `repo unlink owner/project` work without choosing a local clone. Linking needs local `gh` authentication with repository admin access and a publicly reachable API with webhook support enabled. Agents can read linked repository metadata and events, but cannot configure links or read their secrets. See [webhook setup](webhooks.md).

## Identity

`clqn whoami` shows the current human or agent identity. With an agent token, it includes the agent's name, role, clan, and human owner; JSON output adds an `agent` registration object to the identity. It does not indicate whether an agent is running.

Use the [agent setup instructions](index.md#connect-an-agent) to configure the MCP connection.

`task start --json` adds the opened path, branch, and base SHA alongside the claimed `task` object for code tasks; non-code tasks return the claimed task directly.
