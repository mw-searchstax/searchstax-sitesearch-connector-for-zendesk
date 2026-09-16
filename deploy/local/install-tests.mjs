import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalInstaller,
  validateImage,
  checkPrerequisites,
  runInstallerCli,
} from "./install.mjs";

const IMAGE =
  "registry.example/connector@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEXT_IMAGE =
  "registry.example/connector@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const dirs = [];

afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(outputs = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "connector-local-test-"));
  dirs.push(cwd);
  const calls = [];
  const defaultRun = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("init"))
      return outputs.init ?? "CONNECTOR_ID=connector-test\n";
    if (args.includes("schema"))
      return outputs.schema ?? '{"version":10,"latest":10,"pending":[]}\n';
    if (args.includes("migrate"))
      return "MySQL schema is current at version 10.\n";
    if (args.includes("ps"))
      return outputs.ps ?? '{"Service":"app","State":"running"}\n';
    return "";
  };
  const run = outputs.run
    ? async (command, args, options) => {
        calls.push({ command, args, options });
        return outputs.run(command, args, options, calls);
      }
    : defaultRun;
  const installer = createLocalInstaller({
    cwd,
    run,
    random: (size) => Buffer.alloc(size, 7),
    allowLocalImage: true,
  });
  return { cwd, calls, installer };
}

describe("local distribution installer", () => {
  it("rejects control characters in state paths before writing or invoking Docker", async () => {
    const { cwd, calls, installer } = await fixture();
    await assert.rejects(
      installer.init({ image: IMAGE, stateDir: `${cwd}/bad\nAPP_IMAGE=other` }),
      /control characters/,
    );
    assert.equal(calls.length, 0);
  });

  it("requires digest images and generates private state only once", async () => {
    assert.throws(
      () => validateImage("registry.example/connector:latest"),
      /sha256 digest/,
    );
    const { cwd, calls, installer } = await fixture();
    const first = await installer.init({ image: IMAGE });
    const statePath = join(cwd, ".connector-local", "state.json");
    const stateBefore = await readFile(statePath, "utf8");
    const second = await installer.init({ image: IMAGE });
    assert.equal(first.connectorId, "connector-test");
    assert.equal(second.alreadyInitialized, true);
    assert.equal(await readFile(statePath, "utf8"), stateBefore);
    assert.equal(calls.filter((call) => call.args.includes("init")).length, 1);
    assert.equal(
      (await stat(join(cwd, ".connector-local"))).mode & 0o777,
      0o700,
    );
    assert.equal(
      (await stat(join(cwd, ".connector-local", "config-encryption-key")))
        .mode & 0o777,
      0o444,
    );
  });

  it("stops before start, refuses pending schema, and never migrates automatically", async () => {
    const pending = await fixture({
      schema: '{"version":9,"latest":10,"pending":[{"version":10}]}\n',
    });
    await pending.installer.init({ image: IMAGE });
    pending.calls.length = 0;
    await assert.rejects(
      () => pending.installer.start(),
      /schema is not current/,
    );
    assert.deepEqual(
      pending.calls.map((call) =>
        call.args.includes("stop")
          ? "stop"
          : call.args.includes("schema")
            ? "schema"
            : "up",
      ),
      ["stop", "up", "schema"],
    );
    assert.equal(
      pending.calls.some((call) => call.args.includes("migrate")),
      false,
    );

    const ready = await fixture();
    await ready.installer.init({ image: IMAGE });
    ready.calls.length = 0;
    const result = await ready.installer.start();
    assert.equal(result.started, true);
    assert.deepEqual(
      ready.calls.map((call) =>
        call.args.includes("stop")
          ? "stop"
          : call.args.includes("schema")
            ? "schema"
            : "up",
      ),
      ["stop", "up", "schema", "up"],
    );
  });

  it("parses Compose JSON arrays as well as NDJSON status output", async () => {
    const array = await fixture({
      ps: '[{"Service":"mysql","State":"running"},{"Service":"app","State":"exited"}]',
    });
    await array.installer.init({ image: IMAGE });
    assert.deepEqual((await array.installer.status()).services, [
      { service: "mysql", state: "running" },
      { service: "app", state: "exited" },
    ]);

    const ndjson = await fixture({
      ps: '{"Service":"mysql","State":"running"}\n{"Service":"app","State":"running"}\n',
    });
    await ndjson.installer.init({ image: IMAGE });
    assert.deepEqual((await ndjson.installer.status()).services, [
      { service: "mysql", state: "running" },
      { service: "app", state: "running" },
    ]);
  });

  it("records a non-secret owner receipt while a mutation lock is held", async () => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const locked = await fixture({
      run: async (_command, args) => {
        if (args.includes("stop")) await held;
        return args.includes("schema")
          ? '{"version":10,"latest":10,"pending":[]}\n'
          : args.includes("init")
            ? "CONNECTOR_ID=connector-test\n"
            : "";
      },
    });
    await locked.installer.init({ image: IMAGE });
    const pending = locked.installer.start({ action: "start" });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const owner = JSON.parse(
          await readFile(
            join(
              locked.cwd,
              ".connector-local",
              "operation.lock",
              "owner.json",
            ),
            "utf8",
          ),
        );
        assert.equal(owner.pid, process.pid);
        assert.equal(typeof owner.hostname, "string");
        assert.equal(owner.action, "start");
        assert.equal(typeof owner.startedAt, "string");
        assert.equal(Object.hasOwn(owner, "secret"), false);
        release();
        await pending;
        return;
      } catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  });

  it("changes image only after target schema validation and preserves rollback metadata", async () => {
    const { installer, calls } = await fixture();
    await installer.init({ image: IMAGE });
    calls.length = 0;
    const result = await installer.changeImage({ image: NEXT_IMAGE });
    const loaded = await installer.load();
    assert.equal(result.changed, true);
    assert.equal(loaded.state.image, NEXT_IMAGE);
    assert.equal(loaded.state.previousImage, IMAGE);
    assert.deepEqual(
      calls.map((call) => (call.args.includes("stop") ? "stop" : "schema")),
      ["stop", "schema"],
    );
  });
});

describe("installer CLI guidance", () => {
  it("fails prerequisite checks before constructing an installer and hides raw errors", async () => {
    const output = [];
    const failures = [];
    let constructed = false;
    const code = await runInstallerCli(["init", "--image", IMAGE], {
      stdout: (line) => output.push(line),
      stderr: (line) => failures.push(line),
      preflight: () =>
        checkPrerequisites({
          run: async () => {
            throw new Error("password=DO_NOT_PRINT");
          },
        }),
      makeInstaller: () => {
        constructed = true;
      },
    });
    assert.equal(code, 1);
    assert.equal(constructed, false);
    assert.deepEqual(output, []);
    assert.match(failures.at(-1), /Install Docker with Compose/);
    assert.doesNotMatch(failures.join(""), /DO_NOT_PRINT/);
  });

  it("distinguishes an unreachable daemon and an unsupported engine", async () => {
    await assert.rejects(
      checkPrerequisites({
        run: async (_command, args) => {
          if (args.includes("info")) throw new Error("private daemon detail");
          return "v2";
        },
      }),
      /Start Docker or check your Docker context/,
    );
    await assert.rejects(
      checkPrerequisites({
        run: async (_command, args) =>
          args.includes("info") ? "linux/x86_64" : "v2",
      }),
      /requires a Linux ARM64/,
    );
    await checkPrerequisites({
      run: async (_command, args) =>
        args.includes("info") ? "linux/aarch64" : "v2",
    });
  });

  it("keeps success JSON separate from progress and browser handoff", async () => {
    const output = [],
      messages = [];
    const code = await runInstallerCli(["start"], {
      stdout: (line) => output.push(line),
      stderr: (line) => messages.push(line),
      preflight: async () => {},
      makeInstaller: ({ onProgress }) => ({
        start: async () => {
          onProgress("Starting the connector…");
          return { started: true };
        },
      }),
    });
    assert.equal(code, 0);
    assert.deepEqual(output.map(JSON.parse), [{ started: true }]);
    assert.match(messages.join(""), /http:\/\/127.0.0.1:/);
    assert.match(messages.join(""), /background/);
  });

  it("shows argument guidance without Docker and redacts unexpected failures", async () => {
    const messages = [];
    const options = {
      stdout: (line) => messages.push(line),
      stderr: (line) => messages.push(line),
      preflight: async () => {
        throw new Error("SECRET_SENTINEL");
      },
    };
    assert.equal(await runInstallerCli(["--help"], options), 0);
    assert.match(messages.join(""), /Usage:/);
    assert.equal(await runInstallerCli(["init"], options), 1);
    assert.match(messages.join(""), /requires --image/);
    assert.equal(await runInstallerCli(["start"], options), 1);
    assert.doesNotMatch(messages.join(""), /SECRET_SENTINEL/);
  });
});

it("maps registry failures to a safe CTA without exposing subprocess diagnostics", async () => {
  const { installer } = await fixture({
    run: async () => {
      const error = new Error("unauthorized PRIVATE_SENTINEL");
      error.stderr = "password=PRIVATE_SENTINEL";
      throw error;
    },
  });
  await assert.rejects(installer.init({ image: IMAGE }), (error) => {
    assert.match(error.message, /docker login for the image registry/);
    assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/);
    return true;
  });
});
