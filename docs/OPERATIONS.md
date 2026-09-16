# Operations

## Runtime Boundary

MySQL 8.4/InnoDB is the supported persistence path. The supported installation
runs on Linux/arm64 and is intended for one connector, one Zendesk Guide
brand, and one SearchStax Site Search app. This installation supports at most
500 eligible article translations across the selected locales. No broader
capacity, high-availability, or public operator access is supported by this
guide.

Bind operator access to loopback or place it behind a private access boundary.
The app uses `GET /healthz` for process liveness and `GET /readyz` for database,
schema, identity, and key readiness. Neither endpoint calls Zendesk or
SearchStax.

## Webhook Ingress Boundary

Leave `WEBHOOK_SIGNING_SECRET` unset for a local/manual-only installation. For
realtime synchronization, set it through the launcher and configure Zendesk to
send Article published and Article unpublished events to
`POST /api/webhooks/zendesk`.

Webhook delivery requires a deployed HTTPS-reachable endpoint. A trusted
ingress or reverse proxy must expose only this exact route to public inbound
traffic. Keep the operator UI, setup, health/readiness, and every other API
route behind the existing private access boundary. The proxy must preserve or
set the upstream `Host` expected by the private application boundary
(`127.0.0.1:4173` by default). TLS may terminate at the proxy. Do not publish
raw port 4173. Broader provider-neutral ingress and origin qualification is
separate work.

The webhook verifies the signed raw request and then performs a fresh
authenticated Zendesk read. Zendesk remains the source of truth, and scheduled
full reconciliation repairs missed or failed events. Live qualification covers
published, edited, unpublished, duplicate, invalid-signature, and missed-event
repair scenarios. Local tests cover controlled transient failures and transport
reordering. No broader realtime guarantee is made.

## Schema and Restart

Normal startup refuses pending or future schema versions. The launcher applies
the initial schema migrations on a fresh local state and checks the schema on
normal reruns. Run later migrations only with every runtime stopped, after a
backup and a reviewed release check. Keep one active runtime per connector.

Restarting with the same MySQL database, encryption key, and connector identity
preserves configuration, ownership records, history, and scheduling state.
Scheduling is disabled by default.

## Backup and Recovery

Back up MySQL and the configuration encryption key independently. A database
backup without its matching key cannot decrypt saved vendor credentials. Keep
the key, image digest, schema version, connector identity, and backup generation
together in restricted, encrypted operator records.

For local Compose, stop the app and take a MySQL 8.4 logical dump directly to a
mode-0600 file. Restore only into a fresh isolated database. Never overwrite the
sole working copy. Keep vendor egress blocked during restore validation. Verify
schema, identity, decryptability, saved scheduling, ownership records, and
history before promotion. There is no production RTO/RPO guarantee.

## Sync Ownership and Failures

The connector indexes only eligible published public translations in selected
supported locales. It may create or update records in its own namespace and may
delete only records whose ownership and complete source inventory are proven.
It pauses or fails closed when destination ownership, source completeness,
schema, credentials, or cleanup cannot be verified. Preserve state and plans on
uncertain results. Do not clear locks or receipts to force a retry.

Route logs to access-controlled storage with bounded retention. Do not collect
vendor bodies, article content, SQL dumps, full environment output, or secrets
in support records.
