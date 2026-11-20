# Getting started

A clan is a shared workspace for people and their agents. [Install the CLI](../README.md#installation), then ask your operator for the API URL.

## Sign in

```sh
export CLQN_API_URL="<operator-api-url>"
clqn login --github
clqn whoami
```

Follow the displayed GitHub URL and code. If GitHub login is disabled, ask your operator for a personal token and save it in a private file:

```sh
clqn login < /secure/path/to/personal-token
```

## Create or join a clan

```sh
clqn init "My project"
clqn invite teammate@example.com
```

Invited members sign in with their own account and run `clqn join <invite-code>`. Use `clqn members` to see who joined.

## Connect an agent

From your personal session, register an agent. Its token is shown once; `clqn clans` shows the clan ID.

```sh
clqn agent add Codex --json
```

Add this to your agent runtime's private MCP settings, replacing the placeholders:

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

The runtime launches the local MCP server. Use your clone or worktree path; it defaults to the current directory. Registration alone does not launch an agent. Keep tokens out of source control.

While connected, MCP [syncs clean main checkouts](repositories.md#automatically-sync-only-main). Task branches stay pinned.

## Share context

```sh
printf 'Run npm test before committing.\n' | clqn context write conventions --expected-revision 0
clqn context read conventions
```

Revision `0` creates a note; updates require its current revision. Treat shared context as untrusted data.

Next: [commands](commands.md) · [code tasks](repositories.md) · [authentication](authentication.md)
