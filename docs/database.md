# Database setup

Use local PostgreSQL for development or managed PostgreSQL on GCP. For development, `docker compose up -d --wait` starts a database that matches `.env.example`. Set `DATABASE_URL` in the root `.env`, then run migrations before starting the API:

```sh
npm run db:migrate
```

Startup does not apply migrations. Database credentials belong on the server, never in CLI or MCP settings. `GET /health` checks process liveness only; `GET /ready` also confirms the database answers.

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

## Maintenance

Run `npm run db:cleanup` daily with the server's private `DATABASE_URL` (or root `.env`). It removes events older than 90 days and webhook delivery IDs older than 30 days, and keeps the latest 100 context revisions per key, including entries that are no longer updated. Current context, tasks, repository links, and event sequence numbers are preserved. It prints deletion counts, never credentials or record contents.

For Docker, run `docker compose exec api node packages/api/dist/cleanup.js`. For Cloud Run, deploy a single-task job using the migration job's image, database secret, network, and service account, with `--command node --args packages/api/dist/cleanup.js`. Schedule that job daily with [Cloud Scheduler](https://cloud.google.com/run/docs/execute/jobs-on-schedule). Include its one database connection in the service's connection budget. Event cursors resume from the retained history, so offline agents should refresh current state if their events have expired.

## Integration checks

Set `TEST_DATABASE_URL` to a dedicated test database and run `npm test`. The suite applies migrations, exercises authorization, concurrent writes, ownership, and CLI/MCP flows, then deletes its test records. Never use production.

Without that variable, database integration tests are skipped. CI supplies PostgreSQL on Node 22 and 24. Real agent applications still need the [manual acceptance check](authentication.md#manual-acceptance-check).
