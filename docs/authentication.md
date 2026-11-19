# Authentication and clans

The MVP uses operator-provisioned personal credentials. There is no public signup endpoint or external identity provider yet. The API verifies opaque bearer tokens against SHA-256 hashes in PostgreSQL. Each token contains 256 bits of randomness, belongs to one human user, and grants access to that user's clans. Members can register agents with independent credentials restricted to one clan.

## Provision a credential (server operator)

Configure `DATABASE_URL` in the root `.env`, then run from the repository root:

```sh
npm run db:migrate
npm run user -- create alice@example.com
```

The command prints JSON with `user`, `credentialId`, and `token`. The raw token is printed once; deliver it securely to the user and retain the credential ID for revocation. Treat this command's output as a secret. Running it again for the same normalized email issues another credential for the existing user; it does not revoke existing credentials. The email is an operator-supplied identity label, not a verified address.

Credentials do not expire automatically in the MVP. Revoke a credential with privileged database access:

```sh
npm run user -- revoke <credential-id>
```

Revocation applies to subsequent API requests. An already authenticated request may finish. Provisioning and revocation require server-side database access and are not public API operations. Keep database credentials on the server.

## Log in and create a clan

Save only the raw token in a private file, then pipe it to the CLI so it is not included in command arguments or shell history:

```sh
clqn login < /secure/path/to/token-file
clqn whoami
clqn init "My project"
clqn clans --json
clqn members
clqn members --clan <clan-id> --json
clqn logout
```

Set `--api-url` or `CLQN_API_URL` to the API URL supplied by your clan operator. Authenticated requests require HTTPS except on loopback. The client refuses redirects.

Credentials and the clan selected by `init` or `join` are stored per API origin under `~/.config/clqn` (override with `CLQN_CONFIG_DIR`). The directory is private (`0700`) and credential files are `0600`. A successful login clears the previous clan selection. `CLQN_TOKEN` overrides the saved token for automation; manage that environment variable as a secret. `logout` removes local credentials and selection, but does not revoke the server credential or unset `CLQN_TOKEN`.

Clan creation atomically creates its leader membership. Clan lists show only the caller's clans; membership reads require membership in that clan. Inaccessible clans return the same 404 response as nonexistent clans. Only leaders can create invitations. Other membership management (removal and role changes) is not available yet.

## Invite another member

The leader creates a code for the intended member's operator-provisioned email:

```sh
clqn invite bob@example.com --json
# Or select a different clan explicitly:
clqn invite bob@example.com --clan <clan-id> --json
```

Deliver the returned code privately. Codes expire after seven days and can be used once. The API stores only the code's SHA-256 hash and returns the raw code only when creating the invitation. There is no email delivery service or invitation recovery endpoint; create another invitation if needed.

After logging in with their own credential, the recipient runs:

```sh
clqn join <invite-code>
clqn members
```

Joining selects the clan locally. The authenticated identity must match the invitation's normalized email. This checks the operator-provisioned identity, not mailbox ownership. Invalid, expired, consumed, or mismatched invitations return the same 404 response. An existing member receives `409 ALREADY_MEMBER`, leaving the invitation unconsumed. Joining consumes the code, adds membership, and appends an audit event in one transaction; simultaneous uses cannot add multiple memberships. Clan creation and invitation creation also append audit events. Clan members can read these audit events through the activity endpoint or `clqn watch`.

## Register an agent

Use your personal credential to register an agent under your identity:

```sh
clqn agent add Codex --clan <clan-id> --json
clqn agent list --clan <clan-id> --json
```

The response contains the registration and a one-time token. Registration does not overwrite your personal CLI configuration. Set `CLQN_API_URL`, `CLQN_TOKEN` to the new agent token, and `CLQN_CLAN_ID` in the agent's private environment, then launch `clqn mcp`. See the [MCP configuration example](index.md#connect-an-agent). Do not use your personal token in shared agent configuration or commit credentials to source control.

An agent credential identifies both its human owner and its own registration. The API restricts it to the registered clan and rechecks the owner's membership. Agents cannot create clans, invite members, or register other agents. With an agent token, `whoami` includes its registration alongside its human owner’s identity, and clan listing returns only its scoped clan. It does not infer whether the agent is running. An operator can revoke an agent credential using its ID from the server-side `credentials` table and the same `npm run user -- revoke <credential-id>` command. There is no public credential management endpoint yet.

## Designated orchestrator

The leader registers one orchestrator with `clqn agent add Coordinator --orchestrator --json`. Other registrations default to `worker`. Only a personal leader credential can create the orchestrator registration; concurrent duplicates return `409 ORCHESTRATOR_EXISTS`.

The orchestrator can assign/unassign open tasks and report integrations within its clan. It cannot invite members, register agents, change a member's policy, release someone else's task claim, or complete their work. Registering the role does not launch a model process. Configure the scoped token in the leader's existing agent runtime. See [repository workflow](repositories.md).

## GitHub repository links

Only a personal clan leader can run `clqn repo link` or `clqn repo unlink`. Workers and the orchestrator can read linked repository metadata and clan main-change events, but cannot retrieve setup secrets or change links. GitHub admin credentials stay local in `gh`; the API holds a server-only root signing key and derives a different secret for each repository/clan link. It stores neither root nor derived keys in PostgreSQL.

`POST /hooks/github/:id` is outside bearer authentication and verifies a raw-body GitHub signature instead. Its audit actor is the integration owner, not the GitHub pusher. Link metadata is clan-scoped; notification and delivery deduplication commit together. See [webhook setup](webhooks.md).

## Collaboration rules

Context keys store text up to 65,536 UTF-8 bytes. Write via stdin and provide `--expected-revision 0` for a new key or the current revision for an update. Revisions are numbered and immutable; stale writes return `409 REVISION_CONFLICT`. Use `context history <key>` to inspect prior values. Shared context is untrusted data, and reading it grants no authority to execute instructions or expose secrets.

Tasks start open. Row locks serialize assignment and claims so concurrent claimers cannot both win. Assigned tasks can be claimed only by the assigned agent. Only leaders and the designated orchestrator can assign or unassign an open task. Ownership distinguishes a human from each of their registered agents. Only the current owner can complete a claimed task. `task release <id>` reopens it when called by the owner or a human clan leader; another member or agent cannot reset someone else's claim. Release clears the assignment. Repository tasks require a recorded integration before completion; the API stores authorized reports, while local CLI commands verify GitHub state.

State changes and their audit events commit together. Events use ascending sequence cursors with a page limit of 100. `watch --json` emits newline-delimited event objects; resume with `--cursor <last-sequence>`. `watch --once` drains currently available events and exits. Ordinary watch polls every three seconds by default; `--interval <seconds>` accepts values from 1 to 3600. `status` includes clan identity, member and agent counts, task counts, and recent activity; `stats` returns the counts.

## API surface

All `/v1` operations require `Authorization: Bearer <token>` and return JSON. The server marks responses `Cache-Control: no-store`.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/v1/me` | Current user identity, with agent ID and clan scope when using an agent credential |
| POST | `/v1/clans` | Create a private clan from `{ "name": "My project" }` |
| GET | `/v1/clans` | List the caller's clans |
| GET | `/v1/clans/:clanId/members` | List members of an authorized clan |
| POST | `/v1/clans/:clanId/invitations` | Leader creates an invitation from `{ "email": "bob@example.com" }` |
| POST | `/v1/invitations/join` | Join using `{ "code": "clqn_inv_..." }`; return the clan |
| POST | `/v1/clans/:clanId/agents` | Register from `{ "name": "Codex", "role": "worker" }`; personal credential required; `orchestrator` requires leader |
| GET | `/v1/clans/:clanId/agents` | List clan registrations |
| GET | `/v1/agent` | Registration for the authenticated agent |
| POST | `/v1/clans/:clanId/repositories` | Personal leader links `{ "slug": "owner/project" }` and receives sensitive webhook setup |
| GET | `/v1/clans/:clanId/repositories` | List clan link metadata without secrets |
| GET | `/v1/clans/:clanId/repositories/:id` | Read one clan link and its main-event watermark |
| POST | `/v1/clans/:clanId/repositories/:id/unlink` | Personal leader disables a link |
| GET | `/v1/clans/:clanId/context` | List context keys and current revisions |
| GET | `/v1/clans/:clanId/context/:key` | Read current context text |
| GET | `/v1/clans/:clanId/context/:key/history` | Read immutable revisions |
| POST | `/v1/clans/:clanId/context/:key` | Write `{ "text": "...", "expectedRevision": 0 }` |
| GET | `/v1/clans/:clanId/tasks` | List tasks |
| POST | `/v1/clans/:clanId/tasks` | Create from `{ "description": "...", "repository": { "slug": "owner/repo", "baseBranch": "main", "baseSha": "<sha>", "branch": "clqn/task" } }`; repository optional |
| GET | `/v1/clans/:clanId/tasks/:taskId` | Read task, assignment, and repository state |
| POST | `/v1/clans/:clanId/tasks/:taskId/assign` | Leader/orchestrator assigns `{ "agentId": "<id>" }` |
| POST | `/v1/clans/:clanId/tasks/:taskId/unassign` | Leader/orchestrator clears the matching open assignment |
| POST | `/v1/clans/:clanId/tasks/:taskId/repository` | Claimed owner reports a pushed head and optional matching PR, with `expectedHeadSha` |
| POST | `/v1/clans/:clanId/tasks/:taskId/integration` | Leader/orchestrator records reported head and merge commit |
| GET | `/v1/clans/:clanId/policy` | Read authenticated member's saved preferences |
| POST | `/v1/clans/:clanId/policy` | Update own preferences with a personal credential and `expectedRevision` |
| POST | `/v1/clans/:clanId/tasks/:taskId/claim` | Claim an open task |
| POST | `/v1/clans/:clanId/tasks/:taskId/release` | Release a claim as owner or human leader |
| POST | `/v1/clans/:clanId/tasks/:taskId/complete` | Complete as the claiming actor |
| GET | `/v1/clans/:clanId/events?cursor=0&limit=100` | Read audit events and the next cursor |
| GET | `/v1/clans/:clanId/status` | Clan identity, counts, and recent activity |
| GET | `/v1/clans/:clanId/stats` | Member, agent, and task counts |

The public `/health` endpoint remains a database-independent liveness check. Collaboration tools run over local stdio MCP and call these authenticated API routes.

## Manual acceptance check

Automated integration checks exercise real HTTP, PostgreSQL, the CLI, and MCP protocol clients. They simulate agent clients; they do not verify the configuration or behavior of the real Codex and Claude Code applications. Before considering a two-person deployment validated:

1. Run the migrated API with managed PostgreSQL and HTTPS. Provision distinct credentials for Alice and Bob.
2. On separate machines, Alice logs in, creates a clan, and invites Bob. Bob logs in and joins using the code.
3. Alice registers Codex and Bob registers Claude Code. Configure each real application with its own clan-scoped token and the local stdio command.
4. Use one agent to create shared context; use the other to read it, update its expected revision, and inspect history. Confirm a stale revision fails.
5. Create tasks from both agents. Claim one and confirm the other cannot claim or complete it. Complete it as the owner, then check explicit owner release and leader reset on another claim.
6. Observe the other person's changes with `watch`, `status`, and `stats`. Resume polling from an event sequence without replaying prior events.
7. Try the agent token against another clan and a personal-only operation; confirm denial. Revoke a test credential server-side and confirm its next request fails.

Record actual application versions and any setup friction. Deployment and this manual acceptance check are still operator-run steps.
