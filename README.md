# SearchStax Zendesk Connector

The SearchStax Zendesk Connector reads eligible published public translations
from one Zendesk Guide brand and keeps connector-owned records in one
SearchStax Site Search app synchronized.

Each installation connects one Zendesk brand to one SearchStax app. The
connector indexes only eligible published public translations in the locales
you select. The supported installation handles up to 500 eligible translations
across those locales and runs on a Linux/arm64 Docker engine.

## Prerequisites

Before you begin, install or confirm:

- Git
- Docker with Compose support
- A Linux/arm64 Docker engine

Apple Silicon Docker Desktop is supported for this path. Linux/amd64, Windows,
and other deployment platforms are not yet verified. Host Node.js, npm, and a
host MySQL installation are not required.

## What You Need Before Setup

Have the following information ready before you open the setup UI:

- Your Zendesk account subdomain and the authorization method you will use.
- If you use OAuth, a customer-owned Zendesk public client ID. Register the
  fixed callback `http://127.0.0.1:4173/api/oauth/zendesk/callback` and request
  the `brands:read hc:read` scopes. No client secret is required or accepted.
- Your intended Zendesk Guide brand and the locales you want to index.
- Your SearchStax Site Search app, destination name, connector key, update
  endpoint, search endpoint, and Read & Write token.
- An optional SearchStax Preview URL if you want it shown in the dashboard.

The OAuth client ID must be supplied on the first launcher run because the
launcher persists it for later reruns. Choose the authentication path before
you start the connector; the temporary legacy/manual path is a secondary
compatibility option for cases where OAuth is not configured. Normal reruns do
not require re-exporting the OAuth client ID after it has been persisted.

## Quick Start

1. Clone the repository URL supplied with your reviewed SearchStax release and
   change to the repository root:

   ```sh
   git clone REPOSITORY_URL connector
   cd connector
   ```

   Replace `REPOSITORY_URL` with the URL supplied with your release. If you
   choose a different directory name, use it in the `cd` command.

2. Confirm that Docker is running and that the engine reports `linux/arm64`:

   ```sh
   docker version
   docker compose version
   docker info --format '{{.OSType}}/{{.Architecture}}'
   ```

3. Start the connector using the authentication path you chose before setup:
   - For OAuth:

     ```sh
     ZENDESK_OAUTH_CLIENT_ID=YOUR_CLIENT_ID ./deploy/local/launch.sh
     ```

   - For temporary legacy/manual authentication:

     ```sh
     ./deploy/local/launch.sh
     ```

4. Wait for the launcher to print:

   ```text
   Setup is ready at http://127.0.0.1:4173
   ```

5. Open [http://127.0.0.1:4173](http://127.0.0.1:4173) on the Docker host.

The launcher builds the application image, creates private local state, starts
MySQL 8.4, applies the initial schema migrations, and starts the setup UI. It
binds the operator port to loopback. Keep `.connector-local/` private and
recoverable. Rerun the same command after a restart or source update. After an
OAuth client ID is persisted, normal reruns do not require re-exporting it.

For a private remote host, use an operator-controlled SSH tunnel instead of
exposing the operator port:

```sh
ssh -N -L 4173:127.0.0.1:4173 operator@private-host
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173) on the operator
workstation.

## Setup and First Sync

The setup UI guides you through four steps:

1. Select **Connect to Zendesk** for OAuth, or select the temporary legacy API
   token option when OAuth is not configured. Select **Validate Zendesk**.
2. Choose one accessible brand and select **Discover locales**.
3. Select the locales, enter the SearchStax destination details, and select
   **Check connection**. The check validates endpoint and access requirements.
4. Review the brand, locales, destination, and credential status. Select
   **Complete setup** only when they are correct.

Completing setup stores encrypted credentials and starts a background
SearchStax write, read, and cleanup check. The UI shows **Your connection is
saved** while it waits. Keep the connector running. **Sync now** becomes
available after the checks finish. If a check fails, use **Retry index check**
or **Edit SearchStax connection**.

The first **Sync now** performs real Zendesk reads and can create, update, or
delete only SearchStax records whose connector ownership is proven. The
connector stops or fails closed when the complete source inventory, destination
ownership, or cleanup cannot be verified. Scheduling is disabled by default.
Enable it explicitly from the dashboard when you are ready for hourly full
reconciliation.

Read the [SearchStax contract](docs/SEARCHSTAX.md) and
[operations guide](docs/OPERATIONS.md) for endpoint, ownership, recovery, and
failure details.

## Realtime Article Synchronization

The local/manual-only installation does not expose a public webhook. Leave
webhook configuration unset when manual **Sync now** and optional scheduled
reconciliation are sufficient.

For a deployed installation with realtime synchronization:

- Set `WEBHOOK_SIGNING_SECRET` before the first launcher run. The launcher
  stores it in `.connector-local/webhook-signing-secret` with mode `0600` and
  passes it to the container through a file-backed secret.
- Configure Zendesk to send Article published and Article unpublished events to
  the exact `POST /api/webhooks/zendesk` route over HTTPS.
- Expose only that webhook route to public inbound traffic. Keep the operator
  UI, operator routes, health and readiness endpoints, every other API route,
  and raw port 4173 private. The launcher continues to bind the host port to
  loopback. The proxy must preserve or set the upstream `Host` expected by the
  private application boundary (`127.0.0.1:4173` by default).

The launcher keeps the operator UI on its private loopback origin. Broader
provider-neutral ingress and origin qualification is separate work.

The webhook verifies the signed raw request and a timestamp within five minutes,
then performs a fresh authenticated Zendesk read before indexing or removing a
connector-owned record. Full reconciliation remains the repair path for missed
or failed events. Live qualification covers published, edited, unpublished,
duplicate, invalid-signature, and missed-event repair scenarios. Local tests
cover controlled transient failures and transport reordering. No broader
realtime guarantee is made.

## Persistence, Restart, and Recovery

MySQL 8.4 is the supported persistence path. Normal reruns preserve the
connector identity, encryption key, MySQL data, saved configuration, ownership
records, and history. Startup refuses pending or future schema versions rather
than migrating silently.

Back up the MySQL database and configuration encryption key separately. Keep
the matching key, schema version, connector identity, and image digest with the
backup record. Restore into a fresh isolated database before validation. The
installer does not create backups automatically, and there is no production
RTO/RPO or high-availability guarantee.

A long-running deployment requires a private supported Linux/arm64 Docker host.
Provider-specific cloud deployment is not yet a qualified or documented
support path. Read [operations](docs/OPERATIONS.md) for restart, backup,
recovery, and schema procedures.

## Development

The source includes unit, integration, and browser tests. See the
[development guide](docs/DEVELOPMENT.md) for source checks. The supported
customer persistence story is MySQL.

## Support, Security, and Releases

Use the [SearchStax support process](SUPPORT.md) for product and configuration
questions. Report suspected vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), never in a public issue.

Release records, immutable image digests, checksums, and public provenance are
described in [RELEASES.md](docs/RELEASES.md).

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
