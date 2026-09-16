# Operations

## Runtime boundary

MySQL 8.4/InnoDB is the supported persistence path. The supported container
profile is Linux/arm64 and is intended for one connector, one Zendesk Guide
brand, and one SearchStax Site Search app. The container path supports at most
500 eligible article translations across the selected locales. No broader
capacity, high-availability, or public-operator claim is made.

Bind operator access to loopback or place it behind a private access boundary.
The app uses `GET /healthz` for process liveness and `GET /readyz` for database,
schema, identity, and key readiness. Neither endpoint calls Zendesk or
SearchStax.

## Webhook ingress boundary

Set `WEBHOOK_SIGNING_SECRET` only when Zendesk Article published and Article
unpublished events should trigger realtime sync. The endpoint is
`POST /api/webhooks/zendesk`; it verifies the signed raw body and then performs
a fresh authenticated Zendesk read. Zendesk remains the source of truth, and
scheduled full reconciliation remains the repair path for missed or failed
events.

Webhook delivery requires a deployed HTTPS-reachable endpoint. A trusted
ingress or reverse proxy must expose only this exact webhook route to public
inbound traffic. Keep the operator UI, setup, health/readiness, and every other
API route behind the existing private access boundary. Configure
`OPERATOR_ORIGIN` as the exact HTTP(S) origin used by the proxy and preserve its
Host value for the existing host validation; TLS may terminate at the proxy.
Do not publish raw port 4173. Leave `WEBHOOK_SIGNING_SECRET` unset when the
installation is local/manual-only; manual and scheduled synchronization remain
available. Live Zendesk qualification is not part of this source installation
path.

## Schema and restart

Normal startup neither migrates nor initializes. It refuses pending or future
schema versions. Run the explicit `migrate` command only with every runtime
stopped, after a backup and a reviewed release check. Run `schema` first and
require the current version to equal the latest version with no pending
migrations. Keep one active runtime per connector.

Restarting the container with the same MySQL database, encryption key, and
connector identity preserves configuration, ownership records, history, and
scheduling state. Scheduling is disabled by default.

## Backup and recovery

Back up MySQL and the configuration encryption key independently. A database
backup without its matching key cannot decrypt saved vendor credentials. Keep
the key, image digest, schema version, connector identity, and backup generation
together in restricted, encrypted operator records.

For local Compose, stop the app and take a MySQL 8.4 logical dump directly to a
mode-0600 file. Restore only into a fresh isolated database; never overwrite the
sole working copy. Keep vendor egress blocked during restore validation. Verify
schema, identity, decryptability, saved scheduling, ownership records, and
history before promotion. There is no production RTO/RPO guarantee.

## Sync ownership and failures

The connector indexes only eligible published public translations in selected
supported locales. It may create or update records in its own namespace and may
delete only records whose ownership and complete source inventory are proven.
It pauses or fails closed when destination ownership, source completeness,
schema, credentials, or cleanup cannot be verified. Preserve state and plans on
uncertain results; do not clear locks or receipts to force a retry.

Route logs to access-controlled storage with bounded retention. Do not collect
vendor bodies, article content, SQL dumps, full environment output, or secrets
in support records.
