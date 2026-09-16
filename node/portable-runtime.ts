import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { startNodeApplication, type DependencyFactory } from "./application.ts";
import {
  applyMysqlMigrations,
  assertMysqlSchemaCurrent,
  createMysqlConnection,
  inspectMysqlSchema,
} from "./mysql-schema.ts";
import { MysqlReconciliationStore } from "./mysql-store.ts";
import {
  decryptConfiguration,
  type EncryptedEnvelope,
} from "../worker/reconciliation/crypto.ts";

type Environment = Record<string, string | undefined>;

async function secret(env: Environment, name: string) {
  if (env[name] && env[`${name}_FILE`])
    throw new Error(`${name}: choose value or file.`);
  const value = env[`${name}_FILE`]
    ? await readFile(env[`${name}_FILE`]!, "utf8")
    : env[name];
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

export async function runtimeSettings(env: Environment) {
  const databaseUrl = await secret(env, "DATABASE_URL");
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is invalid.");
  }
  if (
    url.protocol !== "mysql:" ||
    !url.hostname ||
    !url.username ||
    !/^\/[a-zA-Z0-9_]+$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error(
      "DATABASE_URL must name a MySQL database without query options.",
    );
  const tls = env.DATABASE_TLS ?? "required";
  if (!["required", "disabled"].includes(tls))
    throw new Error("DATABASE_TLS is invalid.");
  if (tls === "disabled" && env.DATABASE_CA_FILE)
    throw new Error("DATABASE_CA_FILE requires TLS.");
  const ca = env.DATABASE_CA_FILE
    ? await readFile(env.DATABASE_CA_FILE, "utf8")
    : undefined;
  const connect = () =>
    createMysqlConnection(databaseUrl, {
      connectTimeout: 5000,
      ...(tls === "required"
        ? {
            ssl: {
              rejectUnauthorized: true as const,
              verifyIdentity: true as const,
              ...(ca ? { ca } : {}),
            },
          }
        : {}),
    });
  return { connect };
}

export async function portableSettings(env: Environment) {
  const database = await runtimeSettings(env);
  const encryptionKey = await secret(env, "CONFIG_ENCRYPTION_KEY");
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey) ||
    Buffer.from(encryptionKey, "base64").length !== 32
  )
    throw new Error("CONFIG_ENCRYPTION_KEY must encode 32 bytes as base64.");
  const connectorId = env.CONNECTOR_ID;
  if (!connectorId || !/^[a-zA-Z0-9_-]{1,64}$/.test(connectorId))
    throw new Error(
      "CONNECTOR_ID is required and must be a stable identifier.",
    );
  const rawListenAddress = env.LISTEN_ADDRESS ?? "127.0.0.1";
  const listenAddress = rawListenAddress as "127.0.0.1" | "0.0.0.0";
  if (listenAddress !== "127.0.0.1" && listenAddress !== "0.0.0.0")
    throw new Error("LISTEN_ADDRESS is invalid.");
  const port = Number(env.PORT ?? "4173");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT is invalid.");
  let origin: URL;
  try {
    origin = new URL(env.OPERATOR_ORIGIN ?? `http://127.0.0.1:${port}`);
  } catch {
    throw new Error("OPERATOR_ORIGIN is invalid.");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("OPERATOR_ORIGIN must be an HTTP origin.");
  const shutdownMs = Number(env.SHUTDOWN_TIMEOUT_MS ?? "25000");
  if (!Number.isInteger(shutdownMs) || shutdownMs < 1000 || shutdownMs > 120000)
    throw new Error("SHUTDOWN_TIMEOUT_MS is invalid.");
  return {
    ...database,
    encryptionKey,
    connectorId,
    listenAddress,
    port,
    operatorOrigin: origin.origin,
    shutdownMs,
    ...(env.WEBHOOK_SIGNING_SECRET?.trim()
      ? { webhookSigningSecret: env.WEBHOOK_SIGNING_SECRET.trim() }
      : {}),
  };
}

export async function startPortableApplication(
  env: Environment,
  dependencies?: DependencyFactory,
) {
  const settings = await portableSettings(env);
  const store = MysqlReconciliationStore.fromConnectionFactory(
    settings.connect,
    settings.connectorId,
  );
  async function validate() {
    const connection = await settings.connect();
    try {
      await assertMysqlSchemaCurrent(connection);
      const [rows] = await connection.query<Array<{ id: string }>>(
        "SELECT id FROM connector_identity WHERE id = ?",
        [settings.connectorId],
      );
      if (rows.length !== 1)
        throw new Error(
          "Connector must be explicitly initialized before startup.",
        );
    } finally {
      await connection.end?.();
    }
    const config = await store.configuration();
    if (config) {
      if (config.target !== "hosted")
        throw new Error("Portable runtime requires hosted configuration.");
      await decryptConfiguration(
        JSON.parse(config.credentialEnvelope) as EncryptedEnvelope,
        settings.encryptionKey,
      );
    }
  }
  await validate();
  let closing = false;
  let checking: Promise<boolean> | undefined;
  const ready = async () => {
    if (closing) return false;
    checking ??= validate()
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        checking = undefined;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        checking,
        new Promise<boolean>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(false), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const app = await startNodeApplication({
    store,
    encryptionKey: settings.encryptionKey,
    assetRoot: resolve("dist/client"),
    port: settings.port,
    target: "hosted",
    ...(env.ZENDESK_OAUTH_CLIENT_ID
      ? {
          oauth: {
            clientId: env.ZENDESK_OAUTH_CLIENT_ID,
            redirectUri: `${settings.operatorOrigin}/api/oauth/zendesk/callback`,
          },
        }
      : {}),
    webhookSigningSecret: settings.webhookSigningSecret,
    dependencies,
    http: {
      listenAddress: settings.listenAddress,
      operatorOrigin: settings.operatorOrigin,
      ready,
    },
  });
  return {
    origin: app.origin,
    shutdownMs: settings.shutdownMs,
    async close() {
      closing = true;
      await app.close();
    },
  };
}

export function installShutdown(
  app: Awaited<ReturnType<typeof startPortableApplication>>,
) {
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => {
      console.error(
        "Shutdown deadline exceeded; interrupted work will recover on restart.",
      );
      process.exit(1);
    }, app.shutdownMs);
    void app.close().then(
      () => {
        clearTimeout(timeout);
      },
      () => {
        console.error(
          "Shutdown failed; interrupted work will recover on restart.",
        );
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

export function initConnectorId(
  env: Environment,
  random: () => string = randomUUID,
) {
  const id = env.CONNECTOR_ID?.trim() || random();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id))
    throw new Error(
      "CONNECTOR_ID is required and must be a stable identifier.",
    );
  return id;
}

export async function portableCommand(command: string, env: Environment) {
  if (command === "start") {
    const app = await startPortableApplication(env);
    installShutdown(app);
    console.log(`Connector listening at ${app.origin}`);
  } else if (command === "migrate") {
    const { connect } = await runtimeSettings(env);
    const connection = await connect();
    try {
      const result = await applyMysqlMigrations(connection);
      console.log(`MySQL schema is current at version ${result.toVersion}.`);
    } finally {
      await connection.end?.();
    }
  } else if (command === "schema") {
    const { connect } = await runtimeSettings(env);
    const connection = await connect();
    try {
      const state = await inspectMysqlSchema(connection);
      console.log(
        JSON.stringify({
          version: state.version,
          latest: state.latest,
          pending: state.pending.map(({ version }) => version),
        }),
      );
    } finally {
      await connection.end?.();
    }
  } else if (command === "init") {
    const { connect } = await runtimeSettings(env);
    const connection = await connect();
    try {
      await assertMysqlSchemaCurrent(connection);
    } finally {
      await connection.end?.();
    }
    const id = initConnectorId(env);
    await MysqlReconciliationStore.fromConnectionFactory(
      connect,
      id,
    ).ensureConnector();
    console.log(`CONNECTOR_ID=${id}`);
  } else throw new Error("Use start, schema, migrate, or init.");
}
