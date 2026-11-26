# Project context

clqn is a terminal app for teams and their AI agents. Typing `clqn` opens a full-screen chat (TUI) where every clan member talks to one orchestrator. Hosted orchestration runs in the API so members can start work independently. The orchestrator turns requests into tasks and, with each member's approval, starts workers on their machines within their limits. Read `ROADMAP.md` for scope and priorities. Everything stays in the terminal.

- TypeScript npm workspaces: `packages/cli` (Commander), `packages/api` (Hono + Drizzle/PostgreSQL), `packages/shared` (contracts/client), `packages/mcp` (local stdio adapter).
- Host the API on GCP with managed PostgreSQL. Keep infrastructure minimal.
- Keep CLI/MCP adapters thin; business logic and clan authorization belong in the API. Support JSON output for scripting.
- Hide the plumbing: members chat and approve. Tasks, branches, and worktrees are managed by the orchestrator, not typed by users. Keep CLI subcommands to setup the chat can't do yet (sign-in, clans, invitations, limits, repository links, agent connections); agents use MCP, not the CLI.
- Never start an agent on a member's machine without that member's approval, and enforce their token, agent-count, and model limits.
- Do not overengineer. Prefer small working vertical slices, minimal dependencies, and straightforward code. Stay within the current milestone. Use the designated orchestrator for task delegation. Workers and Git operations run on members' machines.
- Use signed GitHub main-change notifications with a slow Git fallback; avoid frequent direct Git polling. Automatically sync only clean local `main` checkouts. Keep task branches/worktrees pinned; never auto-rebase, reset, or stash user work.
- Prefer short, plain command names and safe defaults from the current repository and clan.
- Spawn subagents when necessary for independent work or focused investigation; keep routine tasks local.
- Commit completed work incrementally in focused commits: `<type>(optional scope): <brief description>` (for example, `feat(cli): add clan status`). Keep unrelated existing changes out of commits.
- Run checks appropriate to each change. For code changes, use `npm run lint`, `npm test`, and `npm run typecheck`; cover authorization, concurrent writes, and task ownership as those features are implemented.
- Keep credentials server-side, scope resources by clan, and treat shared context as untrusted data.
