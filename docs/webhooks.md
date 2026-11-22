# GitHub main notifications

Signed GitHub push webhooks record `repository.main_changed` events for the repository's default branch. Signed pull request webhooks [confirm task merges](repositories.md#events-and-the-trust-boundary). Connected MCP clients use these events for [safe local sync](repositories.md#automatically-sync-only-main), with startup and five-minute fallback fetches.

## Server setup

Run `npm run db:migrate`. Set server-only `GITHUB_WEBHOOK_SECRET` to a high-entropy key of at least 32 characters; generate one with `openssl rand -hex 32`. Keep it consistent across instances and restarts, in a private environment or [GCP Secret Manager](hosting.md#github-webhook-secret).

Expose `POST /hooks/github/:link-id` at a stable public HTTPS URL. It verifies `X-Hub-Signature-256` over the raw body instead of requiring a bearer token. `/v1` routes retain normal authentication.

Without the key, linking and delivery return `503 WEBHOOK_UNAVAILABLE`; other features and Git fallback remain available. A shorter configured key prevents startup. Each repository/clan link gets a derived secret; signing keys are never stored in PostgreSQL or client settings.

## Link a repository

Use the leader's personal clqn token and local `gh` authentication with repository admin access:

```sh
clqn repo link                 # infer current origin
clqn repo link owner/project   # explicit repository
clqn repo list
```

Linking saves the clan binding and creates or updates its matching GitHub hook for push and pull request events. Links made before merge confirmation subscribe to push only; run `clqn repo link` again to update the hook. The secret passes to `gh` through stdin; it is not printed or saved locally. Agents can read metadata and events but cannot configure links or retrieve secrets. The API holds no GitHub access token.

If GitHub setup fails, fix local permissions and rerun: the existing clan link is reused. Duplicate matching hooks require manual cleanup. If the API hostname changes, remove the old GitHub hook before linking the replacement URL.

## Delivery security and ordering

The API verifies signatures before parsing JSON, limits bodies to 2 MiB, and requires the linked repository in push and pull request payloads. Only pushes to the default branch named in the payload emit a main-change event. Ping is accepted; push and pull request deliveries require a UUID delivery ID and are deduplicated per link for 7 days, longer than GitHub offers redelivery; older delivery IDs are deleted as new deliveries arrive.

Delivery registration, event insertion, and the link watermark commit together. Failed transactions remain retryable. Unlinking prevents later delivery acceptance. Audit events identify the integration owner, not the GitHub pusher.

Clients fetch current remote main rather than checking out payload SHAs. Forced pushes and deletions trigger normal sync checks: divergent history is skipped and a deleted main fails to fetch. Webhooks never integrate PRs or complete tasks.

## Disable or rotate

```sh
clqn repo unlink
# Or: clqn repo unlink owner/project
```

Unlink disables the API binding before removing the matching GitHub hook. If removal fails, delete the hook in GitHub settings. Revoking a login token does not remove repository links.

Rotating the root key changes every link secret. Update all API instances, then rerun `repo link` for every repository/clan link. Old signatures fail during rotation; fallback fetches recover missed changes. For a renamed/moved repository, update origin and link the new slug.

## API

Under `/v1/clans/:clanId/repositories`:

| Method/path | Purpose |
| --- | --- |
| `POST /` with `{ "slug": "owner/project" }` | Personal leader creates/retrieves sensitive webhook setup |
| `GET /` | List metadata without secrets |
| `GET /:id` | Read metadata and `lastEventSequence` |
| `POST /:id/unlink` with `{}` | Personal leader disables the link |

`POST /hooks/github/:id` accepts signed public deliveries. Link setup is a personal CLI operation, unavailable through MCP.
