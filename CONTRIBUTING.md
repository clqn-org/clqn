# Contributing

Thanks for helping with clqn. It's a lightweight, CLI-first tool, so we favor small, focused changes and few dependencies. Read [ROADMAP.md](ROADMAP.md) for scope before starting larger work.

- **Bugs and ideas:** [open an issue](https://github.com/rli8145/clqn/issues). For larger changes, open an issue first so we can agree on the approach.
- **Security problems:** don't open a public issue. Follow [SECURITY.md](SECURITY.md).

## Prerequisites

- Node.js 22+ and npm 10+
- Docker, for the local PostgreSQL database

## Set up

```sh
git clone https://github.com/rli8145/clqn.git
cd clqn
npm install
cp .env.example .env
docker compose up -d --wait
npm run db:migrate
npm run build
```

`.env.example` already points at the Docker database. Start the API in watch mode:

```sh
npm run dev
```

The API listens on `127.0.0.1:3000`. In another terminal, create a local account and log the CLI in with its one-time token:

```sh
npm run user -- create you@example.com   # prints a JSON object with "token"
printf '%s' '<token>' | npm run cli -- login
npm run cli -- init "Test clan"
```

The CLI uses the local API by default. Watch mode reloads API changes; run `npm run build` again after changing `packages/shared` or the CLI.

## Project structure

| Workspace | Responsibility |
| --- | --- |
| `packages/shared` | Zod contracts, API errors, HTTP client |
| `packages/api` | Hono server, Drizzle schema and migrations |
| `packages/mcp` | Thin stdio MCP adapter |
| `packages/cli` | Commander commands and terminal output |

Business logic and authorization belong in the API. Keep the CLI and MCP adapter thin. Every command should support `--json`.

## Run the checks

```sh
npm run lint        # formatting and lint rules (npm run format fixes most issues)
npm run typecheck
npm test
```

Without a database, `npm test` skips the PostgreSQL integration tests. To run them, create a test database once and point the tests at it:

```sh
docker compose exec db createdb -U postgres clqn_test
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/clqn_test npm test
```

CI runs all checks, including the database tests, on Node 22 and 24.

Write new tests in TypeScript as `packages/<name>/test/*.test.ts` and import the code under test from `../src`. `npm run typecheck` checks them with the same strict settings as the source. Some older tests are still `.mjs`; convert them when you change them.

Changes to authorization, concurrent writes or task ownership need tests that cover them. For schema changes, follow [database setup](docs/database.md#schema-changes) and commit the generated migration.

## Open a pull request

1. Fork the repository and create a branch from `main`.
2. Make one focused change. Keep unrelated cleanup out of it.
3. Run the checks above.
4. Write commit messages as `<type>(optional scope): <description>`, for example `feat(cli): add clan status` or `fix(api): reject expired invitations`.
5. Open the pull request with what changed, why, and how you tested it.

Maintainers: release and deployment steps are in [RELEASING.md](RELEASING.md).
