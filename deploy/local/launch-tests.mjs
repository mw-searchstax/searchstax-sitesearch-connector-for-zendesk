import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = join(root, "deploy/local/launch.sh");
const directories = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fakeDocker(cwd) {
  const bin = join(cwd, "bin");
  await mkdir(bin);
  const log = join(cwd, "docker.log");
  const executable = join(bin, "docker");
  await writeFile(
    executable,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "\${1:-}" = "compose" ]; then
  shift
  last=
  for argument do last=$argument; done
  if [ "$last" = version ]; then exit 0; fi
  if [ "$last" = migrate ]; then printf '%s\\n' 'MySQL schema is current at version 10.'; fi
  if [ "$last" = init ]; then printf '%s\\n' 'CONNECTOR_ID=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; fi
  if [ "$last" = schema ]; then printf '%s\\n' '{"version":10,"latest":10,"pending":[]}'; fi
  exit 0
fi
if [ "\${1:-}" = "info" ]; then
  printf '%s\\n' 'linux/arm64'
  exit 0
fi
if [ "\${1:-}" = "build" ]; then exit 0; fi
if [ "\${1:-}" = "run" ]; then
  case "$*" in
    *"randomBytes(32)"*) printf '%s\\n' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' ;;
    *"randomUUID()"*) printf '%s\\n' 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' ;;
    *"randomBytes(24)"*) printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
  esac
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
  await chmod(executable, 0o755);
  return { bin, log };
}

async function runLauncher(cwd, docker, overrides = {}) {
  const env = {
    ...process.env,
    PATH: `${docker.bin}:${process.env.PATH}`,
    FAKE_DOCKER_LOG: docker.log,
    CONNECTOR_STATE_DIR: join(cwd, ".connector-local"),
    ...overrides,
  };
  return execFileAsync(launcher, [], { cwd, env }).catch((error) => error);
}

describe("local launch configuration", () => {
  it("persists optional settings without logging or replacing them on rerun", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "connector-launch-test-"));
    directories.push(cwd);
    const docker = await fakeDocker(cwd);
    const first = await runLauncher(cwd, docker, {
      ZENDESK_OAUTH_CLIENT_ID: "oauth-first",
      WEBHOOK_SIGNING_SECRET: "webhook-first",
      OPERATOR_ORIGIN: "https://operator.example.com",
    });
    assert.equal(first.code, undefined);
    assert.match(first.stdout, /Setup is ready at http:\/\/127\.0\.0\.1:4173/);

    const second = await runLauncher(cwd, docker, {
      ZENDESK_OAUTH_CLIENT_ID: "oauth-second",
      WEBHOOK_SIGNING_SECRET: "webhook-second",
      OPERATOR_ORIGIN: "https://different.example.com",
    });
    assert.equal(second.code, undefined);

    const state = join(cwd, ".connector-local");
    const runtime = await readFile(join(state, "runtime.env"), "utf8");
    const secret = await readFile(
      join(state, "webhook-signing-secret"),
      "utf8",
    );
    const compose = await readFile(join(state, "compose.env"), "utf8");
    assert.match(runtime, /ZENDESK_OAUTH_CLIENT_ID="oauth-first"/);
    assert.doesNotMatch(runtime, /OPERATOR_ORIGIN/);
    assert.equal(secret, "webhook-first\n");
    assert.match(compose, /RUNTIME_ENV_FILE=.*runtime\.env/);
    assert.match(compose, /WEBHOOK_SECRET_FILE=.*webhook-signing-secret/);
    assert.doesNotMatch(compose, /webhook-first|webhook-second/);
    assert.doesNotMatch(`${first.stdout}\n${first.stderr}`, /webhook-first/);
    assert.doesNotMatch(`${second.stdout}\n${second.stderr}`, /webhook-second/);
    assert.doesNotMatch(
      await readFile(docker.log, "utf8"),
      /webhook-first|webhook-second/,
    );
    assert.equal((await stat(state)).mode & 0o777, 0o700);
    assert.equal((await stat(join(state, "runtime.env"))).mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(state, "webhook-signing-secret"))).mode & 0o777,
      0o600,
    );
  });

  it("uses the loopback operator origin regardless of customer input", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "connector-launch-test-"));
    directories.push(cwd);
    const docker = await fakeDocker(cwd);
    const defaults = await runLauncher(cwd, docker);
    assert.equal(defaults.code, undefined);
    assert.doesNotMatch(
      await readFile(join(cwd, ".connector-local", "runtime.env"), "utf8"),
      /OPERATOR_ORIGIN/,
    );
    assert.equal(
      await readFile(
        join(cwd, ".connector-local", "webhook-signing-secret"),
        "utf8",
      ),
      "\n",
    );

    const overridden = await runLauncher(cwd, docker, {
      OPERATOR_ORIGIN: "https://operator.example.com/attacker-controlled",
    });
    assert.equal(overridden.code, undefined);
  });

  it("keeps the operator port on loopback and uses the persisted runtime files", async () => {
    const compose = await readFile(
      join(root, "deploy/local/compose.yaml"),
      "utf8",
    );
    assert.match(compose, /env_file:\s+- \$\{RUNTIME_ENV_FILE/);
    assert.match(compose, /WEBHOOK_SIGNING_SECRET_FILE/);
    assert.match(
      compose,
      /OPERATOR_ORIGIN:\s+"http:\/\/127\.0\.0\.1:\$\{RUNTIME_PROOF_PORT:-4173\}"/,
    );
    assert.match(compose, /127\.0\.0\.1:\$\{RUNTIME_PROOF_PORT/);
  });
});
