import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  rename,
  readdir,
  rm,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
export const DISTRIBUTION_COMPOSE_FILE = join(HERE, "compose.yaml");
export const DEFAULT_STATE_DIR = resolve(".connector-local");
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:=-]*@sha256:[a-f0-9]{64}$/u;
const LOCAL_IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:=-]*$/u;
const CONNECTOR_RE = /^[A-Za-z0-9_-]{1,64}$/u;

class InstallerError extends Error {}

export function installerErrorMessage(error) {
  if (error instanceof InstallerError) return error.message;
  return "Installation could not finish. Check Docker and file permissions, then retry. Preserve your state directory; do not delete it.";
}

export async function checkPrerequisites({
  run = defaultRun,
  composeBin = process.env.COMPOSE_BIN || "docker",
} = {}) {
  try {
    await run(
      composeBin,
      [...(composeBin === "docker" ? ["compose"] : []), "version"],
      {},
    );
  } catch {
    throw new InstallerError(
      "Docker Compose is unavailable. Install Docker with Compose, then retry (or set --compose-bin to your Compose executable).",
    );
  }
  let platform;
  try {
    platform = normalizeOutput(
      await run(
        process.env.DOCKER_BIN || "docker",
        ["info", "--format", "{{.OSType}}/{{.Architecture}}"],
        {},
      ),
    ).trim();
  } catch {
    throw new InstallerError(
      "Cannot reach Docker. Start Docker or check your Docker context, then retry.",
    );
  }
  if (!["linux/aarch64", "linux/arm64"].includes(platform))
    throw new InstallerError(
      "This release requires a Linux ARM64 Docker engine. Use an ARM64 host; other platforms are not yet verified.",
    );
}

const defaultFs = { mkdir, readFile, writeFile, chmod, rename, readdir, rm };

async function defaultRun(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

export function validateImage(image, { allowLocalImage = false } = {}) {
  if (typeof image !== "string" || image.length > 500 || image.includes("\n"))
    throw new InstallerError("Image is required.");
  if (IMAGE_RE.test(image)) return { image, immutable: true };
  if (allowLocalImage && LOCAL_IMAGE_RE.test(image) && !image.includes("@"))
    return { image, immutable: false };
  throw new InstallerError("Image must be pinned by a sha256 digest.");
}

function dotenv(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function safeProjectName(stateDir) {
  return `connector-local-${createHash("sha256").update(stateDir).digest("hex").slice(0, 12)}`;
}

function statePaths(stateDir) {
  return {
    state: join(stateDir, "state.json"),
    env: join(stateDir, "compose.env"),
    rootPassword: join(stateDir, "mysql-root-password"),
    password: join(stateDir, "mysql-password"),
    databaseUrl: join(stateDir, "database-url"),
    encryptionKey: join(stateDir, "config-encryption-key"),
  };
}

async function atomicWrite(fsApi, path, data, mode) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await fsApi.writeFile(temp, data, { encoding: "utf8", mode });
  await fsApi.chmod(temp, mode);
  await fsApi.rename(temp, path);
  await fsApi.chmod(path, mode);
}

async function readJson(fsApi, path) {
  try {
    return JSON.parse(await fsApi.readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new InstallerError("Local state is unreadable.", { cause: error });
  }
}

function normalizeOutput(output) {
  if (typeof output === "string") return output;
  if (output && typeof output.stdout === "string") return output.stdout;
  return "";
}

function parseSchema(output) {
  const line = normalizeOutput(output)
    .trim()
    .split("\n")
    .map((value) => value.trim())
    .findLast((value) => value.startsWith("{") && value.endsWith("}"));
  if (!line) throw new InstallerError("Schema status was unavailable.");
  let schema;
  try {
    schema = JSON.parse(line);
  } catch {
    throw new InstallerError("Schema status was unavailable.");
  }
  if (
    !Number.isInteger(schema.version) ||
    !Number.isInteger(schema.latest) ||
    !Array.isArray(schema.pending) ||
    schema.version > schema.latest ||
    schema.pending.length > 0 ||
    schema.version !== schema.latest
  )
    throw new InstallerError(
      "Database schema is not current. Keep the app stopped; follow the backup and migration steps in docs/OPERATIONS.md.",
    );
  return { version: schema.version, latest: schema.latest, pending: [] };
}

export function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (
    !action ||
    ![
      "init",
      "start",
      "stop",
      "status",
      "migrate",
      "schema",
      "change-image",
    ].includes(action)
  )
    throw new InstallerError(
      "Use init, start, stop, status, migrate, schema, or change-image.",
    );
  const options = { action, stateDir: DEFAULT_STATE_DIR };
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (
      key === "--image" ||
      key === "--local-image" ||
      key === "--state-dir" ||
      key === "--compose-bin"
    ) {
      const value = rest[++i];
      if (!value || value.startsWith("--"))
        throw new InstallerError(`${key} requires a value.`);
      if (key === "--image") options.image = value;
      if (key === "--local-image") options.localImage = value;
      if (key === "--state-dir") options.stateDir = resolve(value);
      if (key === "--compose-bin") options.composeBin = value;
    } else throw new InstallerError("Unexpected argument.");
  }
  if (options.image && options.localImage)
    throw new InstallerError("Choose one image option.");
  if (options.localImage && process.env.LOCAL_INSTALL_TESTING !== "1")
    throw new InstallerError("Local images are for tests only.");
  if (
    ["init", "change-image"].includes(action) &&
    !options.image &&
    !options.localImage
  )
    throw new InstallerError(`${action} requires --image.`);
  if (options.image) validateImage(options.image);
  if (options.localImage)
    validateImage(options.localImage, { allowLocalImage: true });
  return options;
}

export async function readLocalState(
  directory = DEFAULT_STATE_DIR,
  fsApi = defaultFs,
) {
  return readJson(fsApi, statePaths(resolve(directory)).state);
}

export function createLocalInstaller({
  run = defaultRun,
  fsApi = defaultFs,
  random = randomBytes,
  now = () => new Date().toISOString(),
  cwd = process.cwd(),
  composeFile = DISTRIBUTION_COMPOSE_FILE,
  composeBin = process.env.COMPOSE_BIN || "docker",
  allowLocalImage = process.env.LOCAL_INSTALL_TESTING === "1",
  onProgress = () => {},
} = {}) {
  const stateDir = resolve(cwd);

  async function load(options = {}) {
    const directory = options.stateDir
      ? resolve(options.stateDir)
      : resolve(stateDir, ".connector-local");
    if (
      Array.from(directory).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new InstallerError("State directory contains control characters.");
    const paths = statePaths(directory);
    return { directory, paths, state: await readJson(fsApi, paths.state) };
  }

  async function writeEnv(paths, state) {
    const content = [
      `STATE_DIR=${dotenv(dirname(paths.state))}`,
      `APP_IMAGE=${state.image}`,
      `CONNECTOR_ID=${dotenv(state.connectorId || "")}`,
      `COMPOSE_PROJECT_NAME=${state.projectName}`,
      "",
    ].join("\n");
    await atomicWrite(fsApi, paths.env, content, 0o600);
  }

  async function compose(stateInfo, args, { image } = {}) {
    const state = stateInfo.state;
    const executable = composeBin;
    const prefix = executable === "docker" ? ["compose"] : [];
    const env = {
      ...process.env,
      ...(image ? { APP_IMAGE: image } : {}),
      STATE_DIR: stateInfo.directory,
      APP_IMAGE: image || state.image,
      CONNECTOR_ID: state.connectorId || "",
      COMPOSE_PROJECT_NAME: state.projectName,
    };
    const phase = args.includes("schema")
      ? "Checking database compatibility"
      : args.includes("migrate")
        ? "Preparing database schema"
        : args.includes("init")
          ? "Creating connector identity"
          : args.includes("stop")
            ? "Stopping the connector"
            : args.includes("up")
              ? args.includes("mysql")
                ? "Starting the database"
                : "Starting the connector"
              : "Reading connector status";
    onProgress(`${phase}…`);
    try {
      return normalizeOutput(
        await run(
          executable,
          [
            ...prefix,
            "--project-name",
            state.projectName,
            "--env-file",
            stateInfo.paths.env,
            "-f",
            composeFile,
            ...args,
          ],
          { cwd, env },
        ),
      );
    } catch (error) {
      // Inspect diagnostics only to choose fixed guidance; never print subprocess output.
      const diagnostic = `${error?.stderr || ""} ${error?.message || ""}`;
      const next =
        /unauthorized|authentication required|denied|pull access/iu.test(
          diagnostic,
        )
          ? "Run docker login for the image registry using an account with package access, then retry."
          : /port is already allocated|address already in use/iu.test(
                diagnostic,
              )
            ? "Port 4173 is already in use. Check which application owns it before stopping anything."
            : /no space left/iu.test(diagnostic)
              ? "Free disk space without deleting connector state, then retry."
              : /cannot connect|daemon is not running/iu.test(diagnostic)
                ? "Start Docker or check your Docker context, then retry."
                : "Check Docker service health and consult docs/OPERATIONS.md for recovery steps.";
      throw new InstallerError(
        `${phase} failed. ${next} Preserve your state directory if initialization is incomplete.`,
      );
    }
  }

  async function ensureDirectory(directory) {
    await fsApi.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsApi.chmod(directory, 0o700);
  }

  async function createState(directory, paths, image) {
    const existing = await readJson(fsApi, paths.state);
    if (existing) return existing;
    let entries = [];
    try {
      entries = await fsApi.readdir(directory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (entries.filter((entry) => entry !== "operation.lock").length)
      throw new InstallerError("Local state is incomplete.");
    const password = random(24).toString("hex");
    const rootPassword = random(24).toString("hex");
    const encryptionKey = random(32).toString("base64");
    await atomicWrite(fsApi, paths.rootPassword, rootPassword, 0o444);
    await atomicWrite(fsApi, paths.password, password, 0o444);
    await atomicWrite(
      fsApi,
      paths.databaseUrl,
      `mysql://connector:${password}@mysql:3306/connector\n`,
      0o444,
    );
    await atomicWrite(fsApi, paths.encryptionKey, `${encryptionKey}\n`, 0o444);
    const state = {
      version: 1,
      image,
      previousImage: null,
      connectorId: null,
      projectName: safeProjectName(directory),
      initializedAt: null,
    };
    await atomicWrite(
      fsApi,
      paths.state,
      `${JSON.stringify(state, null, 2)}\n`,
      0o600,
    );
    await writeEnv(paths, state);
    return state;
  }

  async function info(options = {}) {
    const stateInfo = await load(options);
    if (!stateInfo.state)
      throw new InstallerError(
        "Local install is not initialized. Run init --image with the release digest, or select your existing --state-dir.",
      );
    return stateInfo;
  }

  async function withMutationLock(options, operation) {
    const stateInfo = await load(options);
    await ensureDirectory(stateInfo.directory);
    const lockPath = join(stateInfo.directory, "operation.lock");
    try {
      await fsApi.mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST")
        throw new InstallerError(
          "Another local operation is in progress; inspect operation.lock.",
          {
            cause: error,
          },
        );
      throw error;
    }
    try {
      await atomicWrite(
        fsApi,
        join(lockPath, "owner.json"),
        `${JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          startedAt: now(),
          action: options.action || "unknown",
        })}\n`,
        0o600,
      );
      return await operation(await load(options));
    } finally {
      await fsApi.rm(lockPath, { recursive: true, force: true });
    }
  }

  async function init(options = {}) {
    return withMutationLock(options, async (stateInfo) => {
      const supplied = options.image || options.localImage;
      const imageInfo = validateImage(supplied, { allowLocalImage });
      if (stateInfo.state?.connectorId) {
        if (stateInfo.state.image !== imageInfo.image)
          throw new InstallerError("Already initialized; use change-image.");
        return {
          action: "init",
          initialized: true,
          alreadyInitialized: true,
          connectorId: stateInfo.state.connectorId,
        };
      }
      if (stateInfo.state)
        throw new InstallerError(
          "Initialization is incomplete; recover local state before retrying.",
        );
      const state = await createState(
        stateInfo.directory,
        stateInfo.paths,
        imageInfo.image,
      );
      stateInfo.state = state;
      await compose(stateInfo, ["up", "-d", "--wait", "mysql"]);
      await compose(stateInfo, ["run", "--rm", "--no-deps", "app", "migrate"]);
      const output = await compose(stateInfo, [
        "run",
        "--rm",
        "--no-deps",
        "app",
        "init",
      ]);
      const connectorId = [
        ...output.matchAll(/CONNECTOR_ID=([A-Za-z0-9_-]{1,64})/gu),
      ].at(-1)?.[1];
      if (!connectorId || !CONNECTOR_RE.test(connectorId))
        throw new InstallerError(
          "Initialization did not return a connector identity.",
        );
      state.connectorId = connectorId;
      state.initializedAt = now();
      await atomicWrite(
        fsApi,
        stateInfo.paths.state,
        `${JSON.stringify(state, null, 2)}\n`,
        0o600,
      );
      await writeEnv(stateInfo.paths, state);
      return {
        action: "init",
        initialized: true,
        alreadyInitialized: false,
        connectorId,
      };
    });
  }

  async function stop(options = {}) {
    return withMutationLock(options, async () => {
      const stateInfo = await info(options);
      await compose(stateInfo, ["stop", "app"]);
      return {
        action: "stop",
        stopped: true,
        connectorId: stateInfo.state.connectorId,
      };
    });
  }

  async function schema(options = {}, image) {
    const stateInfo = await info(options);
    const output = await compose(
      stateInfo,
      ["run", "--rm", "--no-deps", "app", "schema"],
      { image },
    );
    return { action: "schema", schema: parseSchema(output) };
  }

  async function migrate(options = {}) {
    return withMutationLock(options, async () => {
      const stateInfo = await info(options);
      await compose(stateInfo, ["stop", "app"]);
      await compose(stateInfo, ["up", "-d", "--wait", "mysql"]);
      const output = await compose(stateInfo, [
        "run",
        "--rm",
        "--no-deps",
        "app",
        "migrate",
      ]);
      return {
        action: "migrate",
        migrated: true,
        output: output.includes("MySQL schema is current"),
      };
    });
  }

  async function start(options = {}) {
    return withMutationLock(options, async () => {
      const stateInfo = await info(options);
      if (!stateInfo.state.connectorId)
        throw new InstallerError("Initialize before startup.");
      await compose(stateInfo, ["stop", "app"]);
      await compose(stateInfo, ["up", "-d", "--wait", "mysql"]);
      await schema(options);
      await compose(stateInfo, ["up", "-d", "--wait", "app"]);
      return {
        action: "start",
        started: true,
        connectorId: stateInfo.state.connectorId,
        image: stateInfo.state.image,
      };
    });
  }

  async function status(options = {}) {
    const stateInfo = await info(options);
    const output = await compose(stateInfo, ["ps", "--format", "json"]);
    const services = [];
    let records;
    try {
      const parsed = JSON.parse(output.trim());
      records = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      records = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    }
    for (const item of records) {
      try {
        services.push({
          service: item.Service || item.Name || "unknown",
          state: item.State || item.Status || "unknown",
        });
      } catch {
        // Compose versions may return a human table; the private receipt remains safe.
      }
    }
    return {
      action: "status",
      connectorId: stateInfo.state.connectorId,
      image: stateInfo.state.image,
      services,
    };
  }

  async function changeImage(options = {}) {
    return withMutationLock(options, async () => {
      const supplied = options.image || options.localImage;
      const target = validateImage(supplied, { allowLocalImage });
      const stateInfo = await info(options);
      if (stateInfo.state.image === target.image)
        return { action: "change-image", changed: false, image: target.image };
      await compose(stateInfo, ["stop", "app"]);
      await schema(options, target.image);
      const next = {
        ...stateInfo.state,
        previousImage: stateInfo.state.image,
        image: target.image,
      };
      await atomicWrite(
        fsApi,
        stateInfo.paths.state,
        `${JSON.stringify(next, null, 2)}\n`,
        0o600,
      );
      stateInfo.state = next;
      await writeEnv(stateInfo.paths, next);
      return {
        action: "change-image",
        changed: true,
        image: target.image,
        previousImage: next.previousImage,
        stopped: true,
      };
    });
  }

  return { init, start, stop, status, migrate, schema, changeImage, load };
}

export async function runInstallerCli(
  argv,
  {
    stdout = (message) => console.log(message),
    stderr = (message) => console.error(message),
    preflight = checkPrerequisites,
    makeInstaller = createLocalInstaller,
  } = {},
) {
  try {
    if (argv.length === 0 || argv[0] === "--help") {
      stdout(
        "Usage: node deploy/local/install.mjs <init|start|stop|status|schema|migrate|change-image> [--state-dir PATH] [--image IMAGE@sha256:DIGEST] [--compose-bin PATH]\nFirst install: init --image <release digest>, then start. Credentials are entered in the browser. See docs/CONTAINER.md.",
      );
      return 0;
    }
    const options = parseArgs(argv);
    stderr("Checking Docker and Compose…");
    await preflight({ composeBin: options.composeBin });
    const installer = makeInstaller({
      composeBin: options.composeBin,
      onProgress: stderr,
    });
    const action =
      options.action === "change-image" ? "changeImage" : options.action;
    const result = await installer[action](options);
    stdout(JSON.stringify(result));
    if (action === "init")
      stderr("Initialized. Run start with the same --state-dir to open setup.");
    if (action === "start")
      stderr(
        `Connector started. Open http://127.0.0.1:${process.env.RUNTIME_PROOF_PORT || "4173"}. On a remote server, connect through your SSH tunnel first. Complete setup in the browser; index checks continue in the background.`,
      );
    return 0;
  } catch (error) {
    stderr(installerErrorMessage(error));
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.exitCode = await runInstallerCli(process.argv.slice(2));
