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


## NEXT STEPS
- **Test published packages**: Run a two-person acceptance test on separate machines using real Codex and Claude Code: join one clan, github login, share context, assign work, submit/merge a PR, and observe progress. **Verify live GitHub webhook setup: delivery and clean-main sync, including missed-delivery fallback.**

- [x] Add optional, customizable task and agent aliases alongside UUIDs.
- **set up CI/CD - done by Andy**

- **documentation page on site - fix scrolling mechanics and overall ui**

- **update + clarify: docs + website documentation + contributing.md + agents.md. make sure nothing is overengineered and repo structure is clean. add back docs/assets/demo.gif to README?**
- **persistent command center, liquid glass widget/vscode extension?** 

- **POST ON X, LINKEDIN. Apply to official Homebrew**
- **purge gh history of PLAN.md**




- **Communication:** Asynchronous DMs, group chats.

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
