# GCP hosting

[clqn.org](https://clqn.org/) is the domain for the public website, downloads, and documentation. Each clan operator supplies the HTTPS URL for CLI and MCP access.

The API has a production Docker image and a manual deployment recipe for one Cloud Run service with managed Cloud SQL PostgreSQL. No cloud resources were created or deployed during implementation. The CLI and local stdio MCP adapter run on members' machines and connect over HTTPS.

## Build and run the container

From the repository root:

```sh
docker build -t clqn-api:local .
docker run --rm -p 127.0.0.1:8080:8080 clqn-api:local
```

The multi-stage image builds the API and shared workspace, removes development dependencies, and runs as the non-root `node` user. `.dockerignore` excludes local secrets, dependencies, build outputs, and tests. Defaults are `HOST=0.0.0.0`, `PORT=8080`, and `NODE_ENV=production`; Cloud Run supplies its own `PORT`. Set server-side `DATABASE_URL` for authenticated collaboration. Without it, health works and authenticated requests return 503.

The image includes compiled migration and user-management entrypoints. It does not run migrations at startup. From a privileged admin host with database network access, use a private environment file containing `DATABASE_URL`:

```sh
docker run --rm --env-file /secure/clqn-server.env clqn-api:local node packages/api/dist/db/migrate.js
docker run --rm --env-file /secure/clqn-server.env clqn-api:local node packages/api/dist/manage-user.js create alice@example.com
```

User provisioning prints the personal token once to the operator's terminal; deliver it privately. Do not run provisioning through a job that captures tokens in shared logs. See [database setup](database.md) and [authentication](authentication.md).

## Prepare Google Cloud

Use a Google Cloud project with billing, a same-region Artifact Registry Docker repository, and a Cloud SQL PostgreSQL database with a database user. Configure the database's private IP on a VPC with private services access and a regional subnet reachable by Cloud Run. This recipe uses TCP to the private IP through Direct VPC egress, which requires no connector service. Follow Google's [Cloud SQL private IP setup](https://docs.cloud.google.com/sql/docs/postgres/configure-private-ip) and [Direct VPC egress configuration](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc).

Create a dedicated Cloud Run runtime service account. Store the full URL in a Secret Manager secret, for example `postgresql://clqn:<url-encoded-password>@<private-ip>:5432/clqn?sslmode=require`; match connection encryption settings to the Cloud SQL instance. Grant the runtime account `roles/secretmanager.secretAccessor` on that secret. Use a numbered secret version in deployment commands. The deployer also needs permission to deploy Cloud Run resources, push images, use that service account and subnet, and enable required APIs. See [Cloud Run secret configuration](https://docs.cloud.google.com/run/docs/configuring/services/secrets).

Set the nonsecret deployment values below to your existing resources:

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

Building for `linux/amd64` also works from an Apple Silicon workstation. Images are pushed only when the operator runs these commands. Artifact Registry authentication is described in Google's [Docker authentication guide](https://docs.cloud.google.com/artifact-registry/docs/docker/authentication).

## Migrate, then deploy

Run explicit migrations from a privileged host with database access using the container command above, or run the same image as a one-off Cloud Run migration job on the selected network:

```sh
gcloud run jobs deploy clqn-migrate \
  --project "$CLQN_PROJECT" --region "$CLQN_REGION" \
  --image "$CLQN_IMAGE" --service-account "$CLQN_RUNTIME_ACCOUNT" \
  --network "$CLQN_NETWORK" --subnet "$CLQN_SUBNET" --vpc-egress private-ranges-only \
  --set-secrets "DATABASE_URL=$CLQN_DB_SECRET:$CLQN_DB_SECRET_VERSION" \
  --command node --args packages/api/dist/db/migrate.js \
  --tasks 1 --max-retries 0 --execute-now --wait
```

Proceed only after migration succeeds. The job runs to completion; there is no long-running worker. For a deployment with separate migration credentials, give the job its own account and database secret. Job flags are documented in the [Cloud Run job reference](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/deploy).

Deploy the service with the same release image:

```sh
gcloud run deploy clqn-api \
  --project "$CLQN_PROJECT" --region "$CLQN_REGION" \
  --image "$CLQN_IMAGE" --service-account "$CLQN_RUNTIME_ACCOUNT" \
  --network "$CLQN_NETWORK" --subnet "$CLQN_SUBNET" --vpc-egress private-ranges-only \
  --set-secrets "DATABASE_URL=$CLQN_DB_SECRET:$CLQN_DB_SECRET_VERSION" \
  --port 8080 --max-instances 2 --allow-unauthenticated
```

Cloud Run's unauthenticated transport allows the CLI to send its clqn bearer credential; the API still authenticates all `/v1` routes and authorizes clan access. Cloud Run serves HTTPS. The initial two-instance limit bounds database pool growth (five connections per process); adjust it against the chosen database connection budget. See Google's [container deployment guide](https://docs.cloud.google.com/run/docs/deploying).

Point clients at the returned service URL with `CLQN_API_URL`. Give each agent its registered token through `CLQN_TOKEN` and set `CLQN_CLAN_ID` for its stdio MCP process. Keep database credentials server-side.

## GitHub webhook secret

To enable repository notifications, store a high-entropy root key in GCP Secret Manager and expose its pinned version as `GITHUB_WEBHOOK_SECRET` on the API service. Grant the runtime service account access to this secret as with `DATABASE_URL`. The key must have at least 32 characters and stay consistent across instances; `openssl rand -hex 32` generates a suitable value. Keep the value out of shell arguments, source control, build arguments, and client configuration.

For a webhook-enabled deployment, extend the service's existing `--set-secrets` mapping:

```sh
--set-secrets "DATABASE_URL=$CLQN_DB_SECRET:$CLQN_DB_SECRET_VERSION,GITHUB_WEBHOOK_SECRET=clqn-github-webhook-secret:1"
```

This is a deployment flag fragment, not a separate shell command. The migration job does not need the webhook key. A service without the key can still serve existing APIs and clients can use slower local Git fallback checks, but link setup and delivery return 503.

The public HTTPS service must route `/hooks/github/*` to the API without requiring a bearer token or GCP IAM login. Those requests are authenticated using GitHub signatures, while `/v1` retains its normal bearer/clan checks. Apply migration `0006` first, then have each clan leader run `clqn repo link` using local GitHub admin access. See [webhook setup](webhooks.md) for rotation and recovery.

## Verify a deployment

`GET /health` checks process liveness only. It does not indicate database readiness or authorization. Verify the deployed API with authenticated `whoami`, a clan membership read, and a context/task workflow in a test clan. Run the [two-person acceptance check](authentication.md#manual-acceptance-check) with separate machines and two real agent applications before relying on a deployment for collaboration. Automated local integration and container checks do not verify cloud networking or real agent application settings.

## Enable GitHub login

Follow the OAuth App setup in [authentication](authentication.md#operator-setup). No external app is created automatically. Build/push a new image, run the migration job with that image (migration 0007), then deploy the API image with:

```sh
gcloud run services update clqn-api \
  --region us-central1 \
  --update-env-vars GITHUB_CLIENT_ID=YOUR_OAUTH_APP_CLIENT_ID
```

The client ID is public configuration, not a Secret Manager secret. No new OAuth client secret, IAM permission, callback handler, or networking resource is required. Preserve DATABASE_URL and the independent GITHUB_WEBHOOK_SECRET. Unset GITHUB_CLIENT_ID to disable new GitHub login attempts; existing clqn tokens remain valid until revoked. Test `clqn --api-url https://YOUR_SERVICE_URL login --github`, `whoami`, clan invitations, and operator revocation after deployment. Never enable request/response body logging for authentication routes. Production OAuth approval and GCP deployment are manual verification steps.
