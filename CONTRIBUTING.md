# Contributing

clqn is a lightweight, CLI-first project. Read [ROADMAP.md](ROADMAP.md) for scope and [AGENTS.md](AGENTS.md) for agent workflow instructions. Prefer small working vertical slices and minimal dependencies. Keep business logic in the API and CLI/MCP integrations thin.

## Local development

Use Node.js 22+ and npm 10+:

```sh
npm install
npm run build
cp .env.example .env
npm run dev
```

The API reads the root `.env` on startup and defaults to `127.0.0.1:3000`. Override the listener with `HOST` and `PORT`. API watch mode picks up API source changes; rebuild after changing shared contracts.

The CLI requires a build first. It reads `CLQN_API_URL` from the environment, or accepts `--api-url`; it does not automatically read `.env`.

```sh
npm run cli -- --help
npm run cli -- --api-url http://127.0.0.1:3000 health
```

Successful JSON goes to stdout; errors go to stderr with a nonzero exit code. The MCP adapter reserves stdout for protocol messages and uses the same HTTP client as the CLI.

## Project structure

| Workspace | Responsibility |
| --- | --- |
| `packages/shared` | Zod contracts, API errors, HTTP client |
| `packages/api` | Hono server, Drizzle schema and migrations |
| `packages/mcp` | Thin stdio MCP adapter |
| `packages/cli` | Commander commands and terminal output |

Workspaces build in dependency order with strict TypeScript checking and ESM output.

## Checks

```sh
npm run lint
npm test
npm run typecheck
```

`npm run lint` checks formatting and lint rules with Biome; `npm run format` fixes what it can. `npm test` builds all workspaces and runs Node's built-in test runner. Tests cover HTTP contracts, CLI JSON and failure behavior, MCP discovery and invocation, and a real stdio-to-HTTP flow. Default tests require local loopback access but no database. PostgreSQL integration tests are skipped unless `TEST_DATABASE_URL` is set to a dedicated test database; CI supplies PostgreSQL and runs all checks on Node 22 and 24. See [database setup](docs/database.md).

Checks cover authorization, credential revocation, concurrent clan/context/task/policy writes, orchestrator registration, assignment ownership, and integration gating. Repository acceptance uses real HTTP, PostgreSQL, CLI, local Git branches/pushes, and a fake `gh` that performs a local squash merge. It verifies that a dependent task starts from integrated main and that personal dirty files are preserved. Webhook tests cover raw-body HMAC validation, repository/clan binding, replay races, and unlink ordering. Webhook-to-sync acceptance uses signed HTTP and real API/CLI/Git to prove idle, unrelated, and duplicate events do not trigger Git fetches. Live GitHub hook configuration/delivery, permissions, CI, protected branches, merge queues, and real agent runtimes still require operator acceptance. Local Git helper tests use temporary repositories and fake GitHub responses without network access. For documentation-only changes, check formatting and relative links.

The current Drizzle Kit dependency tree reports four moderate development-only audit findings through its legacy esbuild loader. Production dependencies use patched releases. Avoid running Drizzle's development tooling as a public server; revisit the loader dependency when upgrading Drizzle Kit.

## Commits

Commit incrementally using `<type>(optional scope): <brief description>`, for example `feat(cli): add clan status`. Keep unrelated existing changes out of commits.

## CLI releases

Keep the development workspaces private. Ship the CLI and local MCP adapter together as one package, with Homebrew as the primary installation route. Thin agent plugins can be added later; manual MCP configuration continues to work.

```sh
npm run package:cli
npm run test:package
```

Packaging bundles the CLI and its dependencies into `dist/cli/clqn.mjs`, then creates `dist/clqn-cli-<version>.tgz` and `dist/clqn.rb`. Node.js remains a runtime dependency; users do not build the workspaces. The package test installs the archive into a temporary prefix outside the repository and checks CLI and MCP calls against a local HTTP server.

For a release:

1. Update the version in the root and workspace manifests and `packages/shared/src/index.ts`; refresh the lockfile with `npm install --package-lock-only`.
2. Run `npm test`, `npm run typecheck`, and the packaging commands above. Copy `dist/clqn.rb` to `Formula/clqn.rb`. The formula contains the archive's SHA-256 and its versioned GitHub release URL.
3. Commit the release changes and tag that commit `v<version>`. Upload the exact generated `.tgz` to that GitHub release. Do not rebuild the archive after generating the formula; changing packaged files changes its checksum.
4. On a machine with Homebrew, tap this repository as shown in the README, then run `brew install clqn` and `brew test clqn`. Remove the first-release notices from the install docs when the release is available.

This repository doubles as the Homebrew tap; no separate tap repository is needed. npm users install the same GitHub release archive. Publishing that archive to npm is optional (`npm publish dist/clqn-cli-<version>.tgz --access public`) and requires ownership of the `@clqn` scope. Never publish the private workspace directories directly.
