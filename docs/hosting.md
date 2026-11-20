# GCP hosting

Run the API as one Cloud Run service with managed Cloud SQL PostgreSQL. CLI and MCP run locally and connect to the operator's HTTPS API URL. The public website is hosted separately at clqn.org.

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
  --port 8080 --max-instances 2 --allow-unauthenticated
```

Public transport lets clients send clqn bearer tokens; the API still authenticates `/v1`. Cloud Run provides HTTPS. The two-instance limit bounds the five-connections-per-process database pool; adjust against database capacity.

Set clients' `CLQN_API_URL` to the returned service URL. Keep `DATABASE_URL` server-side.

## GitHub webhook secret

Store a root key of at least 32 characters in Secret Manager (`openssl rand -hex 32` generates one). Grant the runtime account access and keep its value consistent across instances. Extend the service deployment's secret flag:

```sh
--set-secrets "DATABASE_URL=$CLQN_DB_SECRET:$CLQN_DB_SECRET_VERSION,GITHUB_WEBHOOK_SECRET=clqn-github-webhook-secret:1"
```

This is a flag fragment, not a standalone command. The migration job needs no webhook key. Without it, linking/delivery return 503 while Git fallback works.

Allow public `/hooks/github/*` requests through to the API; GitHub signatures authenticate them. Have the personal clan leader run `clqn repo link`. See [webhook setup and rotation](webhooks.md).

## Verify a deployment

`GET /health` checks process liveness only. Test authenticated `whoami`, membership, context, and tasks. Run the [two-person acceptance check](authentication.md#manual-acceptance-check) to verify cloud networking, webhooks, and real agent settings.

## Enable GitHub login

Follow [OAuth App setup](authentication.md#operator-setup). Build a new image, run its migrations, and deploy it before setting the public client ID:

```sh
gcloud run services update clqn-api \
  --project "$CLQN_PROJECT" --region "$CLQN_REGION" \
  --update-env-vars GITHUB_CLIENT_ID=YOUR_OAUTH_APP_CLIENT_ID
```

No client secret is needed. Keep database and webhook settings intact. Unset `GITHUB_CLIENT_ID` to disable new logins; existing clqn tokens remain valid until revoked. Test login, invitations, and revocation. Do not log authentication request/response bodies.
