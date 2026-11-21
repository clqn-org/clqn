# Database setup

Use local PostgreSQL for development or managed PostgreSQL on GCP. For development, `docker compose up -d --wait` starts a database that matches `.env.example`. Set `DATABASE_URL` in the root `.env`, then run migrations before starting the API:

```sh
npm run db:migrate
```

Startup does not apply migrations. Database credentials belong on the server, never in CLI or MCP settings. `GET /health` checks process liveness only.

## Schema changes

Edit schema modules in `packages/api/src/db`, then generate and review SQL:

```sh
npm run db:generate
npm run db:migrate
```

Commit schema changes with their migrations from `packages/api/drizzle`. Add new schema modules to `packages/api/drizzle.config.ts`.

## Data guarantees

PostgreSQL stores identities, clan memberships, invitations, agents, policies, context revisions, tasks, repository links, and audit events.

- Credentials and invitation codes are hashed; webhook signing keys stay outside the database. GitHub login attempts temporarily store device codes, never GitHub access tokens.
- Unique constraints scope memberships, context revisions, task branches, and webhook deliveries. Each clan allows one orchestrator.
- Transactions and locks protect invitation consumption, revision checks, assignment, claims, and ownership. State changes and audit events commit together.

See [authentication](authentication.md) for credentials and permissions.

## Integration checks

Set `TEST_DATABASE_URL` to a dedicated test database and run `npm test`. The suite applies migrations, exercises authorization, concurrent writes, ownership, and CLI/MCP flows, then deletes its test records. Never use production.

Without that variable, database integration tests are skipped. CI supplies PostgreSQL on Node 22 and 24. Real agent applications still need the [manual acceptance check](authentication.md#manual-acceptance-check).
