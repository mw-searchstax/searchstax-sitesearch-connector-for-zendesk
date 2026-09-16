# Installation

## Supported path

The supported source installation requires Git and a Linux/arm64 Docker engine
with Compose support. Host Node.js, npm, and MySQL are not required. Linux/amd64,
Windows, Kubernetes, and public operator access are not verified by this path.

From the repository root, run:

```sh
./deploy/local/launch.sh
```

The launcher verifies Docker, builds the application image locally, creates
`.connector-local/` with restrictive permissions, generates independent MySQL
passwords and a 32-byte configuration encryption key, creates the connector
identity, applies the explicit MySQL migrations, and starts the app on
`127.0.0.1:4173`.

The state directory and MySQL volume are durable. Run the same command after a
restart or source update; it does not replace existing state. If initialization
fails, preserve the state directory and fix the reported Docker, port, disk,
or permissions issue before retrying.

## Browser and vendor setup

Open `http://127.0.0.1:4173` on the installation host. For a private remote
host, forward the loopback port over an operator-controlled SSH tunnel. Keep
the UI private; do not publish it directly to the internet.

The setup wizard collects Zendesk and SearchStax configuration. Enter vendor
credentials only in the private setup UI. Saving SearchStax settings performs a
live compatibility write/read/delete check. Complete setup only against the
intended brand and destination app.

## Optional realtime webhook delivery

Set `WEBHOOK_SIGNING_SECRET` to enable Zendesk Article published and Article
unpublished delivery at `POST /api/webhooks/zendesk`. The event only triggers a
fresh authenticated article read from Zendesk, which remains the source of
truth; the connector then uses its existing eligibility, indexing, and
ownership safeguards. Scheduled full reconciliation repairs missed or failed
events.

Webhook delivery requires a deployed HTTPS-reachable endpoint. Put the
connector behind a trusted ingress or reverse proxy that permits public
inbound traffic only for `POST /api/webhooks/zendesk`. Keep the setup UI,
operator routes, and all other API routes private. Configure `OPERATOR_ORIGIN`
as the exact HTTP(S) origin used by that proxy and preserve the Host value for
the connector's existing host validation; TLS may terminate at the proxy. Do
not publish raw port 4173.

Leave `WEBHOOK_SIGNING_SECRET` unset for a local/manual-only installation.
Manual sync and scheduled reconciliation do not require webhook configuration.
Realtime delivery has been qualified against a live Zendesk account for
published, edited, unpublished, duplicate, invalid-signature, and missed-event
repair scenarios. Controlled transient-failure injection and transport
reordering remain covered by local synthetic tests; no broader realtime
guarantee is made.

## Reviewed image installation

When a public immutable image is available, use the reviewed installer with a
full `@sha256:` digest. Do not use a mutable tag as deployment identity. The
public release record must provide the image digest, platform, checksums, and
rollback constraints.
