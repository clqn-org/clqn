# Commands

Most of the time you only need `clqn`: it signs you in, lets you pick or create a clan, and opens the [chat](chat.md). Everything else is done from the chat. These commands cover setup the chat doesn't handle.

| Command | What it does |
| --- | --- |
| `clqn` | Sign in, choose a clan, and open the chat |
| `clqn --backup` | Offer to host orchestration while this chat is open, if nominated |
| `clqn host <member>` / `clqn host off` | Nominate a backup host by email or ID, or clear it (leader only) |
| `clqn whoami` | Show who you're signed in as |
| `clqn clans` | List your clans |
| `clqn use <clan>` | Switch to another clan by name |
| `clqn invite <email>` | Invite someone to your clan (leader only) |
| `clqn members` | List clan members |
| `clqn members remove <member>` | Remove a member by email (leader only) |
| `clqn members transfer <member>` | Make another member the leader (leader only) |
| `clqn leave` | Leave the clan (the leader must transfer leadership first) |
| `clqn repo link [owner/repo]` | Link a GitHub repository to the clan (leader only) |
| `clqn repo list` | List linked repositories |
| `clqn repo unlink [owner/repo]` | Unlink a repository and remove its webhook (leader only) |
| `clqn agent list` | List agent connections |
| `clqn agent add <name>` | Register an agent for a [custom MCP client](authentication.md#custom-mcp-clients) |
| `clqn agent revoke <agent>` | Revoke an agent's credential |
| `clqn agent token <agent>` | Replace an agent's credential |
| `clqn health` | Check that the server is up |

## Options

| Option | What it does |
| --- | --- |
| `--clan <id>` | Run a clan command on another clan than the selected one |
| `--api-url <url>` | Use a different clqn server |
| `--json` | Print machine-readable JSON |
| `--verbose` | Show Git and GitHub CLI error output, with credentials redacted (or set `CLQN_VERBOSE=1`) |

Run `clqn <command> --help` for every option.

## API list pagination

For scripts calling the API directly: paginated lists accept `?limit=1..200` (most default to 100). Pass the returned `nextCursor` as `after` to get the next page. CLI list commands follow pages for you.
