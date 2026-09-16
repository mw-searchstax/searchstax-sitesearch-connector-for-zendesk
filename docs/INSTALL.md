# Installation

## Supported Installation Path

The supported source installation requires Git, Docker with Compose, and a
Linux/arm64 Docker engine. Apple Silicon Docker Desktop is supported. Host
Node.js, npm, and MySQL are not required. Linux/amd64, Windows, and other
deployment platforms are not yet verified.

From the repository root, run:

```sh
./deploy/local/launch.sh
```

The launcher builds the application image, creates `.connector-local/` with
restrictive permissions, generates independent MySQL credentials and a
configuration encryption key, creates the connector identity, applies the
explicit MySQL migrations, and starts the app on `127.0.0.1:4173`.

The state directory and MySQL volume are durable. Run the same command after a
restart or source update. If initialization fails, preserve the state directory
and fix the reported Docker, port, disk, or permissions issue before retrying.

## Configure Optional Settings

The launcher accepts these optional settings from its process environment on
the first run:

- `ZENDESK_OAUTH_CLIENT_ID` enables the customer-managed OAuth public-client
  flow.
- `WEBHOOK_SIGNING_SECRET` enables realtime Article published and Article
  unpublished delivery.

The launcher saves the OAuth client ID in `.connector-local/runtime.env` with
mode `0600`. It saves the webhook signing secret in
`.connector-local/webhook-signing-secret` with mode `0600` and mounts that file
into the app as a Docker secret. It never prints these values and does not put
them in Git. The operator UI remains on the private loopback origin.

Normal reruns preserve the saved files and do not replace established values
from newly exported environment variables. To change a setting, stop the app,
edit the corresponding file while it remains private, restore mode `0600`, and
rerun the launcher. Leave the webhook secret empty or unset for a
local/manual-only installation.

For OAuth, register the fixed callback
`http://127.0.0.1:4173/api/oauth/zendesk/callback` and request `brands:read
hc:read`. The connector does not require or accept a client secret.

## Browser Setup

Open `http://127.0.0.1:4173` on the installation host. For a private remote
host, forward the loopback port over an operator-controlled SSH tunnel. Keep
the UI private and do not publish it directly to the internet.

The setup wizard validates Zendesk access, lets you choose one brand and
locales, and collects the SearchStax update endpoint, search endpoint,
destination name, connector key, Read & Write token, and optional Preview URL.
Review these values before selecting **Complete setup**.

Saving setup stores encrypted credentials and starts a background SearchStax
write, read, and cleanup check. The UI shows **Your connection is saved** while
it waits. Keep the connector running. **Sync now** becomes available after the
checks complete. Scheduling is disabled until you enable it.

## Realtime Webhook Delivery

Leave `WEBHOOK_SIGNING_SECRET` unset for a local/manual-only installation.
Manual sync and scheduled full reconciliation do not require webhook
configuration.

For realtime delivery, configure Zendesk to send events over HTTPS to the exact
`POST /api/webhooks/zendesk` route. Put the connector behind a trusted ingress
or reverse proxy that exposes only this route to public inbound traffic. Keep
the setup UI, operator routes, health and readiness endpoints, and every other
API route private. The proxy must preserve or set the upstream `Host` expected
by the private application boundary (`127.0.0.1:4173` by default). Do not
publish raw port 4173. Broader provider-neutral ingress and origin
qualification is separate work.

The webhook verifies the signed raw request and then performs a fresh
authenticated Zendesk read. Scheduled full reconciliation repairs missed or
failed events. Live qualification covers published, edited, unpublished,
duplicate, invalid-signature, and missed-event repair scenarios. Local tests
cover controlled transient failures and transport reordering. No broader
realtime guarantee is made.

## Reviewed Image Installation

When a public immutable image is available, use the reviewed installer with a
full `@sha256:` digest. Do not use a mutable tag as deployment identity. The
public release record must provide the image digest, platform, checksums, and
rollback constraints.
