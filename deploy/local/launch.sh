#!/bin/sh
set -eu

if [ "${1:-}" = "--help" ]; then
  printf '%s\n' "Usage: ./deploy/local/launch.sh" "Builds and starts the local source checkout with Docker Compose." >&2
  exit 0
fi
if [ "$#" -ne 0 ]; then
  printf '%s\n' "Usage: ./deploy/local/launch.sh" >&2
  exit 2
fi

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
STATE_DIR=${CONNECTOR_STATE_DIR:-"$ROOT_DIR/.connector-local"}
STATE_DIR=$(CDPATH= cd -- "$(dirname -- "$STATE_DIR")" && pwd)/$(basename -- "$STATE_DIR")
COMPOSE_FILE=$ROOT_DIR/deploy/local/compose.yaml
IMAGE=${CONNECTOR_IMAGE:-searchstax-zendesk-connector:local}
PROJECT_NAME=${CONNECTOR_COMPOSE_PROJECT:-connector-local}
PORT=${RUNTIME_PROOF_PORT:-4173}

fail() {
  printf 'Launch failed: %s\n' "$1" >&2
  printf '%s\n' 'Preserve .connector-local and fix the named issue before retrying.' >&2
  exit 1
}

compose() {
  if ! docker compose --project-name "$PROJECT_NAME" --env-file "$STATE_DIR/compose.env" -f "$COMPOSE_FILE" "$@"; then
    fail "Docker Compose could not complete '$1'. Check Docker, the port, and available disk space."
  fi
}

write_once() {
  path=$1
  mode=$2
  value=$3
  [ ! -e "$path" ] || return 0
  temp="$path.tmp.$$"
  (umask 077 && printf '%s\n' "$value" >"$temp") || fail "Could not write local state."
  chmod "$mode" "$temp"
  mv "$temp" "$path"
}

printf '%s\n' 'Checking Docker and Compose…' >&2
docker compose version >/dev/null 2>&1 || fail 'Docker Compose is unavailable. Install Docker with Compose.'
platform=$(docker info --format '{{.OSType}}/{{.Architecture}}' 2>/dev/null) || fail 'Docker is not running. Start Docker and retry.'
case "$platform" in
  linux/arm64|linux/aarch64) ;;
  *) fail 'This supported launch path requires a Linux ARM64 Docker engine.' ;;
esac

cd "$ROOT_DIR"
printf '%s\n' 'Building the application image from this checkout…' >&2
docker build --tag "$IMAGE" --build-arg APP_VERSION=source --build-arg VCS_REF=local --build-arg OCI_SOURCE="${OCI_SOURCE:-unset}" . || fail 'The source image did not build.'

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
LOCK_DIR=$STATE_DIR/operation.lock
mkdir "$LOCK_DIR" 2>/dev/null || fail 'Another launch is already using this state directory.'
cleanup() {
  rm -rf "$LOCK_DIR"
}
trap cleanup EXIT INT TERM

for name in mysql-password mysql-root-password database-url config-encryption-key connector-id; do
  if [ -e "$STATE_DIR/$name" ] && [ ! -s "$STATE_DIR/$name" ]; then
    fail "Local state file $name is empty. Preserve the state directory for recovery."
  fi
done
if [ -e "$STATE_DIR/connector-id" ]; then
  for name in mysql-password mysql-root-password database-url config-encryption-key; do
    [ -s "$STATE_DIR/$name" ] || fail "Local state is incomplete; missing $name."
  done
else
  for name in mysql-password mysql-root-password database-url config-encryption-key; do
    [ ! -e "$STATE_DIR/$name" ] || fail 'Local state is incomplete; do not overwrite it.'
  done
  mysql_password=$(docker run --rm --entrypoint node "$IMAGE" -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))") || fail 'Docker could not generate local database credentials.'
  root_password=$(docker run --rm --entrypoint node "$IMAGE" -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))") || fail 'Docker could not generate local database credentials.'
  encryption_key=$(docker run --rm --entrypoint node "$IMAGE" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))") || fail 'Docker could not generate the local encryption key.'
  connector_id=$(docker run --rm --entrypoint node "$IMAGE" -e "process.stdout.write(require('node:crypto').randomUUID())") || fail 'Docker could not generate the connector identity.'
  write_once "$STATE_DIR/mysql-password" 0444 "$mysql_password"
  write_once "$STATE_DIR/mysql-root-password" 0444 "$root_password"
  write_once "$STATE_DIR/database-url" 0444 "mysql://connector:$mysql_password@mysql:3306/connector"
  write_once "$STATE_DIR/config-encryption-key" 0444 "$encryption_key"
  write_once "$STATE_DIR/connector-id" 0600 "$connector_id"
fi

connector_id=$(sed -n '1p' "$STATE_DIR/connector-id")
case "$connector_id" in
  ''|*[!A-Za-z0-9_-]*) fail 'The saved connector identity is invalid.' ;;
esac
cat >"$STATE_DIR/compose.env.tmp.$$" <<EOF
APP_IMAGE="$IMAGE"
CONNECTOR_ID=$connector_id
STATE_DIR="$STATE_DIR"
RUNTIME_PROOF_PORT=$PORT
EOF
chmod 600 "$STATE_DIR/compose.env.tmp.$$"
mv "$STATE_DIR/compose.env.tmp.$$" "$STATE_DIR/compose.env"

if [ ! -e "$STATE_DIR/initialized" ]; then
  printf '%s\n' 'Starting MySQL and applying explicit schema migrations…' >&2
  compose up -d --wait mysql
  compose run --rm --no-deps app migrate
  init_output=$(compose run --rm --no-deps app init) || fail 'Connector identity initialization failed. Preserve local state and retry.'
  printf '%s\n' "$init_output" | grep -F "CONNECTOR_ID=$connector_id" >/dev/null || fail 'The saved connector identity was not initialized.'
  write_once "$STATE_DIR/initialized" 0600 initialized
fi

compose up -d --wait mysql
compose run --rm --no-deps app schema >/dev/null
printf '%s\n' 'Starting the connector…' >&2
compose up -d --wait app
printf '%s\n' "Setup is ready at http://127.0.0.1:$PORT"
printf '%s\n' 'Rerun this command to rebuild/restart safely; local identity, key, MySQL data, and schema state are preserved.'
