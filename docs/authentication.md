# Authentication and clans

Humans sign in with GitHub or an operator-issued token. Agents use separate tokens scoped to one clan. The API checks clan membership on every request; inaccessible clans return 404.

## Provision a credential (server operator)

Set `DATABASE_URL` in the root `.env`, then run:

```sh
npm run db:migrate
npm run user -- create alice@example.com
npm run user -- revoke <credential-id>
```

Creation prints `user`, `credentialId`, and a one-time `token`. Deliver the token privately and keep the credential ID for revocation. Repeating creation issues another credential without revoking earlier ones. Operator-supplied email addresses are identity labels, not verified addresses.

Tokens do not expire automatically. Revocation blocks subsequent requests; a request already authenticated may finish. Database access stays server-side.

## Log in and create a clan

```sh
clqn login --github
# Or use an operator-issued token:
clqn login < /secure/path/to/token-file
clqn whoami
clqn init "My project"
clqn clans
clqn members
clqn logout
```

Set `CLQN_API_URL` or `--api-url` to your operator's URL. Authenticated requests require HTTPS except on loopback; redirects are refused.

Credentials and clan selection are stored per API origin in `~/.config/clqn` (`CLQN_CONFIG_DIR` overrides it), with private directory/file permissions. Login clears the previous clan selection; `init` and `join` select a clan. Use `--clan <id>` to override it.

`CLQN_TOKEN` overrides the saved token. Logout revokes the saved token on the server, then removes local credentials and selection. It does not revoke or unset `CLQN_TOKEN`. If the API is unreachable, local credentials are still removed and the output reports that revocation failed.

## Invite another member

Only a human leader can create invitations:

```sh
clqn invite bob@example.com
```

Deliver the code privately. It expires after seven days and can be used once. There is no email delivery or code recovery; create another invitation if needed.

The recipient signs in with the matching email identity, then runs:

```sh
clqn join <invite-code>
```

Invalid, expired, consumed, or mismatched codes return 404. Existing members receive `409 ALREADY_MEMBER` without consuming the code. Member removal and role changes are not available yet.

## Register an agent

```sh
clqn agent add Codex --json
clqn agent list
```

Use your personal credential. Configure the returned one-time token in the agent's [private MCP settings](index.md#connect-an-agent); registration leaves your personal login unchanged.

Agents act as distinct task owners under their human owner. Their tokens are restricted to one clan and require the owner's continued membership. Agents cannot create clans, invite people, or register agents. `whoami` shows the agent and owner, not whether the agent is running.

Revoke or replace agent tokens with your personal credential:

```sh
clqn agent revoke codex   # owner or clan leader; the agent stays listed but cannot authenticate
clqn agent token codex    # owner only; prints a new one-time token and invalidates the old one
```

The leader can revoke any agent in the clan but cannot obtain another member's agent token. Operators can still revoke any credential with `npm run user -- revoke <credential-id>`.

## Designated orchestrator

The human leader registers one coordinator per clan:

```sh
clqn agent add Coordinator --orchestrator --json
```

The orchestrator can assign open tasks and report integrations. It cannot change membership or policies, release another actor's claim, or complete another actor's task. Duplicate registration returns `409 ORCHESTRATOR_EXISTS`; replacing a registration is not supported. See [repository workflow](repositories.md).

## Collaboration rules

- Context values are limited to 65,536 UTF-8 bytes. Writes require the current revision (`0` to create); stale writes return `409 REVISION_CONFLICT`. `context history <key>` reads immutable revisions.
- Only the assigned agent can claim assigned work. Unassigned work can be claimed by any clan member or agent. Concurrent claims cannot both succeed.
- Only the exact claimant can report code or complete a task. The claimant or human leader can release it, clearing its assignment. Code tasks require recorded integration before completion.
- State changes and audit events commit together. Event reads use ascending cursors with a maximum page size of 100.
- Shared context and task descriptions grant no permission to execute commands or expose secrets.

## API surface

All `/v1` routes require `Authorization: Bearer <token>` and return JSON with `Cache-Control: no-store`. Routes under `/v1/clans/:clanId` cover members, agents, context, tasks, policies, repositories, status, stats, and events. Personal-only and leader-only restrictions match the CLI rules above.

`GET /v1/me` returns the current identity. `POST /v1/clans` creates a clan; `GET /v1/clans` lists accessible clans. Invitations use `POST /v1/clans/:clanId/invitations` and `POST /v1/invitations/join`.

`GET /health` is public process liveness, independent of the database. [Webhook deliveries](webhooks.md) use signatures instead of bearer tokens. MCP is a local stdio adapter to the authenticated API.

## Manual acceptance check

Before relying on a deployment, test on separate machines with real Codex and Claude Code applications:

1. Sign in as two people; create a clan, invite, and join.
2. Register each agent and configure its own scoped token.
3. Share context, update it, inspect history, and confirm stale revisions fail.
4. Assign, claim, submit, merge, and complete a code task. Confirm other actors cannot claim assigned work or complete it; test owner and leader release.
5. Check `status`, `log`, live webhook delivery, clean-main sync, and missed-delivery fallback.
6. Confirm agent access to another clan and personal-only operations fails. Revoke a test token and confirm its next request fails.

Record application versions and setup issues. Automated MCP tests simulate clients; they do not validate real application settings or cloud networking.

## GitHub device login

`clqn login --github` displays a URL and code, waits up to 15 minutes, and saves a clqn token. In JSON mode, prompts go to stderr and identity goes to stdout; tokens are not printed. Piped token login remains supported.

GitHub accounts are bound by numeric user ID and require a verified primary email for invitations. Accounts are never linked by email: a collision with an operator-created account returns `account_conflict`. Account linking and primary-email changes require operator reconciliation.

GitHub tokens are used only in server memory. Device codes are temporarily stored server-side and cleaned up after completion, failure, or expiry. A lost completion response requires a fresh login. Revoking GitHub authorization does not revoke an issued clqn token.

### Operator setup

Create a dedicated GitHub OAuth App with **Device Flow** enabled. Set its homepage to the project site and required callback URL to the API origin; device flow uses no callback route. Set `GITHUB_CLIENT_ID` on the API and apply migrations before deployment. No client secret or repository permissions are needed. Leave the ID unset to disable new logins.

Enabling login allows any qualifying GitHub user to create an account, but grants no clan membership. The API has process-local admission and polling limits, including 10 login starts per minute per client address (the last `X-Forwarded-For` entry, which Cloud Run sets). Behind an additional load balancer, that entry is the balancer, so clients share one limit. Configure edge rate limits before broad public signup. Keep authentication bodies out of logs.

Public endpoints: `POST /auth/github/start` and `POST /auth/github/poll`; send the polling handle in the JSON body. See [GitHub's device-flow documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).
