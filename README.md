# SearchStax Zendesk Connector

The SearchStax Zendesk Connector reads published public article translations
from one Zendesk Guide brand and keeps the connector-owned records in one
SearchStax Site Search app synchronized.

The connector is designed for one installation, one brand, and one destination
app. It indexes only eligible published public translations in supported
locales. The supported container path is limited to 500 eligible translations
across the selected locales and runs on a Linux/arm64 Docker engine.

## Prerequisites

- Git
- Docker with Compose support
- A Linux/arm64 Docker engine (Apple Silicon Docker Desktop is supported for
  this boundary; Linux/amd64 and other deployment platforms are not yet
  verified)

Host Node.js, npm, and a host MySQL installation are not required for the
supported source launch.

## Quick start

From a clean checkout:

```sh
./deploy/local/launch.sh
```

Open `http://127.0.0.1:4173` on the Docker host. The launcher builds the image,
creates the local MySQL state and encryption key once, applies explicit schema
migrations, and starts the setup UI. It binds the operator port to loopback.
Keep `.connector-local/` private and recoverable. Rerunning the command is
safe; it preserves the connector identity, key, and database volume.

For a private host, use an operator-controlled SSH tunnel rather than exposing
the port publicly:

```sh
ssh -N -L 4173:127.0.0.1:4173 operator@private-host
```

Then open `http://127.0.0.1:4173` on the operator workstation.

## Setup and sync safety

The browser setup collects Zendesk and SearchStax settings. OAuth is available
when the deployment supplies the customer's public Zendesk client identifier;
no client secret is accepted by the connector. Setup and readiness checks make
vendor calls only after the operator submits the relevant settings.

Saving SearchStax setup performs a write/read/delete compatibility check.
Selecting **Sync now** reads Zendesk and may create, update, or delete only
records that the connector can prove it owns. It fails closed when the complete
source inventory or destination ownership cannot be verified. Scheduling is
disabled by default.

See [installation](docs/INSTALL.md), [operations](docs/OPERATIONS.md), and the
[SearchStax contract](docs/SEARCHSTAX.md) before enabling a real sync.

## Realtime article synchronization

The connector can update SearchStax after a Zendesk Guide article is published
or unpublished. Set `WEBHOOK_SIGNING_SECRET` to enable the inbound endpoint:
`POST /api/webhooks/zendesk`. The connector verifies the signed raw request
body and requires a parseable timestamp within five minutes of receipt, then
treats the event as a trigger rather than as source content: it performs a
fresh authenticated Zendesk article read before indexing or removing the
connector-owned SearchStax record.

Webhook delivery requires a deployed HTTPS-reachable endpoint. Use a trusted
ingress or reverse proxy that exposes only this webhook path for public inbound
traffic. Keep the operator UI and every other API route behind the existing
private access boundary, and do not publish raw port 4173. Configure the
connector's `OPERATOR_ORIGIN` as the exact HTTP(S) origin used by the trusted
proxy and preserve that Host value; TLS may terminate at the proxy.

Scheduled full reconciliation remains the repair path for missed or failed
events. Leave `WEBHOOK_SIGNING_SECRET` unset for a local/manual-only
installation; manual sync and scheduled reconciliation remain available.
Realtime delivery has been qualified against a live Zendesk account for
published, edited, unpublished, duplicate, invalid-signature, and missed-event
repair scenarios. Controlled transient-failure injection and transport
reordering remain covered by local synthetic tests; no broader realtime
guarantee is made.

## Persistence, restart, and recovery

MySQL 8.4 is the supported persistence path. Normal startup refuses pending or
future schema versions; migration is explicit and requires the runtime to be
stopped. Back up MySQL and the configuration encryption key separately, keep
the key with the matching backup generation, and restore into a fresh isolated
database before validation. There is no production RTO/RPO guarantee.

Read [operations](docs/OPERATIONS.md) for health checks, backup, recovery,
upgrade, rollback, and support boundaries.

## Development

The source includes the product tests and browser acceptance tests. Use the
commands in [development](docs/DEVELOPMENT.md). The public source presents one
customer persistence story: MySQL.

## Support, security, and releases

Use the existing SearchStax customer support process for product questions;
this repository does not promise GitHub Issues as a support channel. Report
suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md),
never in a public issue.

Release records, immutable image digests, checksums, and public-commit
provenance are described in [RELEASES.md](docs/RELEASES.md). The first public
release must use a new version and tag; historical private prereleases are not
public releases.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
