# clqn — Development Plan

clqn is a lightweight, open-source CLI for humans and their own AI agents to collaborate in shared cloud workspaces (**clans**).

**Your agents. My agents. One workspace.**

## Architecture

```text
Humans + existing agent runtimes
        CLI / local stdio MCP
                 HTTPS
              clqn API
             PostgreSQL
```

- TypeScript npm workspaces: CLI (Commander), API (Hono + Drizzle), shared contracts/client, and MCP adapter.
- One API service on GCP with managed PostgreSQL; thin CLI/MCP adapters, server-side business logic and authorization.
- A leader-owned orchestrator assigns work and coordinates Git integration. Agents execute locally in isolated task worktrees; GitHub remains the code source of truth.
- MCP is the current agent integration. A2A and remote MCP are outside the MVP.
- Use ordinary queries and transactions. Add infrastructure only for a concrete need.

## Implemented

- Private clans, membership, expiring single-use invitations, personal tokens, and clan-scoped agent credentials.
- Shared context with immutable revisions and stale-write conflict checks.
- Tasks with assignment, ownership, claim/release/completion, and transactional audit events.
- Designated orchestrator, local worktrees, branch publication, exact-head PR checks, squash merge, and recorded integration before code-task completion.
- Signed GitHub main-change notifications with replay suppression. Sync polls clan events every 15 seconds and uses a five-minute Git fallback.
- CLI repository/clan defaults, compatible command aliases, JSON output, local stdio MCP tools, status, watch, and basic stats.
- Stored member token/model/control policies; enforcement still requires metering and a runner.

Automated acceptance covers two users and two MCP clients through the HTTP API and PostgreSQL. The production container and migration entrypoint are verified locally. Real application setup, deployed networking, and live GitHub delivery remain unverified.

## NEXT STEPS

1. Two-person acceptance test locally
2.  Deploy the API and managed PostgreSQL on GCP with explicit migrations.
3. Run a two-person acceptance test on separate machines using real Codex and Claude Code: join one clan, share context, assign work, submit/merge a PR, and observe progress.
4. Verify live GitHub webhook setup/delivery and clean-main sync, including missed-delivery fallback.
5. Fix setup and workflow friction, update installation docs, and validate the MVP before selecting extensions.

**Success:** Two people using different agents collaborate on real code without manually transferring context between sessions.

## EXTENSIONS

- **Make a logo, GIF header**
- **POST ON X, LINKEDIN, BOT YT VIEWS, BOT STARS/GH ACTIVITY, BOT NPM DOWNLOADS**

- **Communication:** Asynchronous DMs, group chats.
- **Accompanying wbsite:** Static introduction, installation, documentation, and release links. Make it aesthetic and minimalist. Inspiration: https://ghostty.org/
- **Metric commands** Commands yield more detailed and interactive metric and usage visualizations.

- **Interoperability and context:** A2A, remote MCP, context branching, and artifact storage through separate proposals.

- **Shared compute:** Deferred as a separate effort requiring explicit opt-in and isolation.
- **Coordination:** Task dependencies, leases, capability profiles, and explicit worktree refresh checkpoints.
- **Activity:** Filters or SSE if cursor-based polling proves inadequate.
- **Onboarding:** Public signup, identity-provider integration, and credential rotation.
- **Execution:** Metering, enforceable usage limits, and approval-aware runners; unattended scheduling requires a separate design.


## Guardrails

- Keep product functionality in the terminal; no dashboard or GUI. Build on existing agent runtimes.
- Scope resources by clan and enforce authorization in the API. The orchestrator cannot administer membership/policies or complete another actor's task.
- Keep task ownership, row-locked transitions, revision checks, and atomic audit writes. Only the assigned agent may claim assigned work; only the exact task owner may report code or complete it.
- Automatically fast-forward only clean local `main`. Keep task branches pinned; never auto-rebase, reset, or stash user work.
- Keep credentials scoped and provider secrets server-side; GitHub operations use local `gh`. Treat shared context as untrusted data.
- Registration does not launch agents or grant access to local files, secrets, or compute. Privileged or destructive actions require human approval.
- Keep dependencies minimal, preserve command compatibility, and ship small vertical slices. For code changes, run `npm test` and `npm run typecheck`, covering authorization, concurrency, and ownership.

## References

[Commands](docs/commands.md) · [Authentication](docs/authentication.md) · [Repository workflow](docs/repositories.md) · [Webhooks](docs/webhooks.md) · [Policies](docs/policies.md) · [Database](docs/database.md) · [GCP deployment](docs/hosting.md)
