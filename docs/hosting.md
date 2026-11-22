# Hosting

CLI and MCP run locally and connect to the operator's API URL. Self-host the API with Docker Compose on one machine, or run it on Cloud Run with managed Cloud SQL PostgreSQL.

## Self-host with Docker Compose

From a clone of this repository, one command builds the API, starts PostgreSQL, applies migrations, and serves the API on `127.0.0.1:8080`:

```sh
docker compose --profile server up -d --wait
docker compose exec api node packages/api/dist/manage-user.js create you@example.com
printf '%s' '<token>' | clqn --api-url http://127.0.0.1:8080 login
```

The second command prints a one-time personal token; deliver tokens privately. Rerun the first command after pulling updates; it rebuilds the image and applies new migrations.

Set `POSTGRES_PASSWORD`, `GITHUB_CLIENT_ID` ([GitHub login](authentication.md)), and `GITHUB_WEBHOOK_SECRET` ([webhooks](webhooks.md)) in a private `.env` file next to `docker-compose.yml` to configure them. Set `POSTGRES_PASSWORD` before the first start; the database keeps its original password afterward.

Authenticated clients require HTTPS except on loopback. To share the API with teammates, put a TLS reverse proxy in front of port 8080, for example `caddy reverse-proxy --from clqn.example.com --to 127.0.0.1:8080`, and give them the HTTPS URL. Back up the `pgdata` volume.

## Cloud Run on GCP

Run the API as one Cloud Run service with managed Cloud SQL PostgreSQL. The following sections cover this setup.

## Build and run the container

```sh
docker build -t clqn-api:local .
docker run --rm -p 127.0.0.1:8080:8080 clqn-api:local
```

The image runs as non-root on port 8080. Set server-side `DATABASE_URL` for authenticated requests; without it, only health works. Migrations are explicit. From a host with database access, use a private environment file:

```sh
docker run --rm --env-file /secure/clqn-server.env clqn-api:local node packages/api/dist/db/migrate.js
docker run --rm --env-file /secure/clqn-server.env clqn-api:local node packages/api/dist/manage-user.js create alice@example.com
```

Provisioning prints a one-time token. Deliver it privately; avoid jobs that capture it in shared logs.

## Prepare Google Cloud

Create these resources in a project with billing:

- A same-region Artifact Registry Docker repository and Cloud SQL PostgreSQL database/user.
- A VPC with private services access and a regional subnet. Use [Cloud SQL private IP](https://docs.cloud.google.com/sql/docs/postgres/configure-private-ip) and [Direct VPC egress](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc).
- A dedicated runtime service account with `roles/secretmanager.secretAccessor` on the database secret.
- A Secret Manager secret containing the full database URL, such as `postgresql://clqn:<url-encoded-password>@<private-ip>:5432/clqn?sslmode=require`. Match encryption settings to the instance.

The deployer needs permission to deploy Cloud Run, push images, use the service account/subnet, and enable APIs. Set these values for your resources:

```sh
CLQN_PROJECT=your-project
CLQN_REGION=us-central1
CLQN_REPOSITORY=your-docker-repository
CLQN_RELEASE=your-release-tag
CLQN_RUNTIME_ACCOUNT=clqn-api@your-project.iam.gserviceaccount.com
CLQN_NETWORK=your-vpc
CLQN_SUBNET=your-regional-subnet
CLQN_DB_SECRET=clqn-database-url
CLQN_DB_SECRET_VERSION=1
CLQN_IMAGE="$CLQN_REGION-docker.pkg.dev/$CLQN_PROJECT/$CLQN_REPOSITORY/clqn-api:$CLQN_RELEASE"

gcloud services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project "$CLQN_PROJECT"
gcloud auth configure-docker "$CLQN_REGION-docker.pkg.dev"
docker build --platform linux/amd64 -t "$CLQN_IMAGE" .
docker push "$CLQN_IMAGE"
```

## Migrate, then deploy

Run migrations with the release image on the database network:

```sh
gcloud run jobs deploy clqn-migrate \
  --project "$CLQN_PROJECT" --region "$CLQN_REGION" \
  --image "$CLQN_IMAGE" --service-account "$CLQN_RUNTIME_ACCOUNT" \
  --network "$CLQN_NETWORK" --subnet "$CLQN_SUBNET" --vpc-egress private-ranges-only \
  --set-secrets "DATABASE_URL=$CLQN_DB_SECRET:$CLQN_DB_SECRET_VERSION" \
  --command node --args packages/api/dist/db/migrate.js \
  --tasks 1 --max-retries 0 --execute-now --wait
```

After migration succeeds, deploy the same image:

```sh
gcloud run deploy clqn-api \
  --project "$CLQN_PROJECT" --region "$CLQN_REGION" \
  --image "$CLQN_IMAGE" --service-account "$CLQN_RUNTIME_ACCOUNT" \
  --network "$CLQN_NETWORK" --subnet "$CLQN_SUBNET" --vpc-egress private-ranges-only \
  --set-secrets "DATABASE_URL=$CLQN_DB_SECRET:$CLQN_DB_SECRET_VERSION" \
  --port 8080 --concurrency 80 --max-instances 4 --allow-unauthenticated
```

Public transport lets clients send clqn bearer tokens; the API still authenticates `/v1`. Cloud Run provides HTTPS.

Each instance opens up to `DATABASE_POOL_SIZE` database connections (default 10), so the service can use max instances × pool size connections: 40 with the flags above. Keep that below your Cloud SQL instance's `max_connections`, with room for the migration job and admin tools. Requests wait for a free connection when an instance's pool is busy. To serve more traffic, raise the database tier first, then `--max-instances` or `DATABASE_POOL_SIZE` (set it with `--update-env-vars`).

Each instance allows 300 `/v1` requests per minute per credential and answers `429` with `Retry-After` beyond that, before any database work. Instances count separately, so the service-wide limit is up to max instances × 300. Unauthenticated floods need limits at the edge, such as Cloud Armor in front of a load balancer.

Storage is capped per account and clan: each user can create 25 clans and register 25 agents per clan, a clan holds up to 500 context entries, and each entry keeps its latest 100 revisions. Writes past a cap return `409 LIMIT_REACHED`. Change the caps in `packages/api/src/limits.ts`.

Set clients' `CLQN_API_URL` to the returned service URL. Keep `DATABASE_URL` server-side.

## GitHub webhook secret

Store a root key of at least 32 characters in Secret Manager (`openssl rand -hex 32` generates one). Grant the runtime account access and keep its value consistent across instances. Extend the service deployment's secret flag:

```sh
--set-secrets "DATABASE_URL=$CLQN_DB_SECRET:$CLQN_DB_SECRET_VERSION,GITHUB_WEBHOOK_SECRET=clqn-github-webhook-secret:1"
```

This is a flag fragment, not a standalone command. The migration job needs no webhook key. Without it, linking/delivery return 503 while Git fallback works.

Allow public `/hooks/github/*` requests through to the API; GitHub signatures authenticate them. Have the personal clan leader run `clqn repo link`. See [webhook setup and rotation](webhooks.md).

## Verify a deployment

`GET /health` checks process liveness only; `GET /ready` returns `503` until the database answers, so use it for load balancer or startup probes. Test authenticated `whoami`, membership, context, and tasks. Run the [two-person acceptance check](authentication.md#manual-acceptance-check) to verify cloud networking, webhooks, and real agent settings.

## Enable GitHub login

Follow [OAuth App setup](authentication.md#operator-setup). Build a new image, run its migrations, and deploy it before setting the public client ID:

```sh
gcloud run services update clqn-api \
  --project "$CLQN_PROJECT" --region "$CLQN_REGION" \
  --update-env-vars GITHUB_CLIENT_ID=YOUR_OAUTH_APP_CLIENT_ID
```

No client secret is needed. Keep database and webhook settings intact. Unset `GITHUB_CLIENT_ID` to disable new logins; existing clqn tokens remain valid until revoked. Test login, invitations, and revocation. Do not log authentication request/response bodies.
