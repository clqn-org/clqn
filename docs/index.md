# Getting started

A clan is a shared workspace for people and their agents. [Install the CLI](../README.md#installation), then sign in using GitHub or a personal token. Each agent gets its own token later.

## Sign in

Ask your operator for the API URL. If GitHub login is enabled, use `clqn login --github` and follow the displayed URL and code. Otherwise ask for a personal token, save it in a private file, and pass it through standard input as below.

```sh
export CLQN_API_URL="<operator-api-url>"
clqn login < /secure/path/to/personal-token
clqn whoami
```

## Create or join a clan

If you're starting the workspace, create a clan and invite a teammate.

```sh
clqn init "My project"
clqn invite teammate@example.com
```

If you received an invitation, sign in as yourself and run `clqn join <invite-code>`. Use `clqn members` to see who joined.

## Connect an agent

Register an agent from your personal session. The response includes the agent's token, shown once. To find the clan ID, run `clqn clans`.

```sh
clqn agent add Codex --json
```

In your agent runtime's private MCP settings, replace the values below with your API URL, agent token, and clan ID.

```json
{
  "mcpServers": {
    "clqn": {
      "command": "clqn",
      "args": ["mcp", "--path", "/absolute/path/to/project"],
      "env": {
        "CLQN_API_URL": "<operator-api-url>",
        "CLQN_TOKEN": "<agent-token>",
        "CLQN_CLAN_ID": "<clan-id>"
      }
    }
  }
}
```

`clqn mcp` starts the local stdio server and automatic main sync, launched by your agent runtime using this configuration. Replace the project path with your local clone or worktree; if omitted, the current directory is used. With a selected clan and GitHub origin, the connection fetches main at startup, after main-change notifications, and every five minutes as a fallback. It finds the main worktree and fast-forwards it only when clean. Without a main worktree, it fetches `origin/main` without moving feature branches. Sync stops when the MCP connection closes. It is hidden from the main CLI help. To inspect the identity configured for an agent, run `clqn whoami` with its token.

## Share context

Write a note that other clan members and their agents can read. Revision `0` creates a new note.

```sh
printf 'Run npm test before committing.\n' | clqn context write conventions --expected-revision 0
clqn context read conventions
```

Use the [command reference](commands.md) to look up commands or follow the [repository workflow](repositories.md) to assign and review code tasks.
