# Database setup

Use local PostgreSQL for development or managed PostgreSQL on GCP. Set `DATABASE_URL` in the root `.env` to the connection string, then run:

```sh
npm run db:migrate
```

The committed Drizzle migrations create users, credentials, clans, memberships, invitations, agents, context entries and revisions, tasks, and audit events. Repository links bind a GitHub slug to a clan and store the latest notification event sequence. GitHub delivery IDs have a composite primary key per link for replay suppression; unlink cascades its delivery rows. Signing keys stay out of PostgreSQL. Credentials and invitation codes are stored as SHA-256 hashes. Membership pairs and context revision numbers are unique within their scope. Agent registrations belong to a human owner and one clan. The agent role is `worker` or `orchestrator`; a partial unique index permits one orchestrator per clan. Memberships store agent policy settings and their revision. Tasks store an optional assigned agent and repository metadata; repository branches are unique per clan and repository.

Migrations are explicit and use a single connection suitable for the migration endpoint supplied by your database provider. Run migrations before starting the updated API. Application startup does not apply them automatically.

## Schema changes

Edit the feature schema in `packages/api/src/db/schema.ts`, `context.ts`, or `tasks.ts`, then generate a migration:

```sh
npm run db:generate
```

Review the generated SQL in `packages/api/drizzle` before applying it with `npm run db:migrate`. Commit schema changes and their generated migrations together. Adding a new schema module also requires adding its path to `packages/api/drizzle.config.ts`.

## Transactions and authorization

Authenticated routes require PostgreSQL and verify credentials, clan scope, and membership on the server. Invitation consumption and membership creation commit together. Context writes require the expected revision and append immutable revision rows. Conditional task updates enforce ownership and prevent concurrent claimers from both succeeding. Audit events commit in the same transaction as state changes; event sequences support bounded cursor polling.

See [authentication and collaboration](authentication.md) for provisioning and API routes. Direct SQL access is privileged and remains server-side. Keep `DATABASE_URL` out of CLI and MCP configuration. Health checks need no database and indicate process liveness only.

## Integration checks

Set `TEST_DATABASE_URL` to a dedicated test PostgreSQL database to run integration checks with `npm test`. The suite applies migrations and exercises identity isolation, invitations, scoped agents, context revision conflicts, task ownership and concurrent claims, audit activity, and CLI/MCP flows. It deletes its own test records afterward. Without this variable, database integration tests are skipped; passing smoke tests alone does not verify persistence or concurrency.

CI provides PostgreSQL and runs the suite on Node 22 and 24. Never point integration tests at a production database. Automated MCP protocol checks simulate clients; real Codex and Claude Code setup still needs the [manual acceptance check](authentication.md#manual-acceptance-check).

Optional GitHub login adds a unique nullable `users.github_id` identity binding and transient `github_logins` attempts. Polling handles are hashed; device codes are temporarily stored server-side until expiration/completion cleanup. GitHub access/refresh tokens are not persisted. See [authentication](authentication.md#github-device-login).
