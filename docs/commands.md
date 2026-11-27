# Commands

Most of the time you only need `clqn`: it signs you in, lets you pick or create a clan, and opens the [chat](chat.md). Everything else is done from the chat. These commands cover setup the chat doesn't handle.

| Command | What it does |
| --- | --- |
| `clqn` | Sign in, choose a clan, and open the chat |
| `clqn host` | Show the current backup hosts (leader only) |
| `clqn host <member...>` / `clqn host off` | Replace or clear the backup list (leader only). Use member emails or IDs |
| `clqn whoami` | Show who you're signed in as |
| `clqn clans` | List your clans |
| `clqn use <clan>` | Switch to another clan by name or ID |
| `clqn invite <email>` | Invite someone to your clan (leader only) |
| `clqn members` | List clan members |
| `clqn members remove <member>` | Remove a member by email or user ID and revoke their agents (leader only) |
| `clqn members transfer <member>` | Make another member, by email or user ID, the leader (leader only) |
| `clqn leave` | Leave the clan (the leader must transfer leadership first) |
| `clqn delete <clan>` | Delete a clan by name or ID for every member, with its chat, tasks, agents, and repository links (leader only). The chat's settings (**Ctrl+S**) have the same **Delete clan** row |
| `clqn repo link [owner/repo]` | Link a GitHub repository to the clan (leader only). Defaults to the `origin` of the current folder, or of `--path <dir>` |
| `clqn repo list` | List linked repositories |
| `clqn repo unlink [owner/repo]` | Unlink a repository and remove its webhook (leader only) |
| `clqn agent list` | List agent connections |
| `clqn agent add <name>` | Register an agent for a [custom MCP client](authentication.md#custom-mcp-clients) |
| `clqn agent revoke <agent>` | Revoke an agent's credential, by ID or alias (its owner or the leader) |
| `clqn agent token <agent>` | Replace an agent's credential (its owner) |
| `clqn health` | Check that the server is up |

## Options

| Option | What it does |
| --- | --- |
| `--clan <id>` | Run a clan command on another clan than the selected one |
| `--api-url <url>` | Use a different clqn server |
| `--json` | Print machine-readable JSON |
| `--version` | Print the clqn version |
| `--verbose` | Show Git and GitHub CLI error output, with credentials redacted (or set `CLQN_VERBOSE=1`) |

Run `clqn <command> --help` for every option, such as `agent add --alias` and `--show-token`.

## Environment variables

| Variable | What it does |
| --- | --- |
| `CLQN_API_URL` | Server to use, after `--api-url` and before the saved server |
| `CLQN_TOKEN` | Use this token instead of the saved sign-in |
| `CLQN_CLAN_ID` | Use this clan instead of the selected one, and skip the clan picker |
| `CLQN_CONFIG_DIR` | Where clqn saves settings and credentials (default `~/.config/clqn`) |
| `CLQN_VERBOSE` | `1` does the same as `--verbose` |
| `NO_COLOR` | Turn off colors |

## API list pagination

For scripts calling the API directly: paginated lists accept `?limit=1..200` (most default to 100). Pass the returned `nextCursor` as `after` to get the next page. CLI list commands follow pages for you.
