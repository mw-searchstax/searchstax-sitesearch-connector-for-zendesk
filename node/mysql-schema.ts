import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface MysqlConnection {
  query<T = unknown>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<[T, unknown]>;
  beginTransaction?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  end?(): Promise<void>;
}

export interface MysqlMigration {
  version: number;
  name: string;
  path: string;
}

const MIGRATION_DIR = new URL("../mysql-migrations/", import.meta.url);

export async function mysqlMigrations(): Promise<MysqlMigration[]> {
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const migrations = names.map((name) => {
    const match = /^(\d+)_([a-z0-9_]+)\.sql$/i.exec(name);
    if (!match) throw new Error(`Invalid MySQL migration filename: ${name}`);
    return {
      version: Number(match[1]),
      name: match[2]!,
      path: join(MIGRATION_DIR.pathname, name),
    };
  });
  if (
    migrations.some(
      (migration, index) =>
        index > 0 && migration.version <= migrations[index - 1]!.version,
    )
  ) {
    throw new Error("MySQL migration versions must be unique and ordered.");
  }
  return migrations;
}

async function currentVersion(connection: MysqlConnection): Promise<number> {
  try {
    const [rows] = await connection.query<Array<{ version: number }>>(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    );
    const version = Number(rows[0]?.version ?? 0);
    if (!Number.isSafeInteger(version) || version < 0)
      throw new Error("MySQL migration metadata was invalid.");
    return version;
  } catch (error) {
    if (
      error instanceof Error &&
      /doesn't exist|does not exist/i.test(error.message)
    )
      return 0;
    throw error;
  }
}

export async function inspectMysqlSchema(connection: MysqlConnection) {
  const migrations = await mysqlMigrations();
  const version = await currentVersion(connection);
  const latest = migrations.at(-1)?.version ?? 0;
  if (version > latest)
    throw new Error(
      `MySQL schema version ${version} is newer than application ${latest}.`,
    );
  return {
    version,
    latest,
    pending: migrations.filter((migration) => migration.version > version),
  };
}

export async function applyMysqlMigrations(connection: MysqlConnection) {
  const state = await inspectMysqlSchema(connection);
  for (const migration of state.pending) {
    const sql = await readFile(migration.path, "utf8");
    if (connection.beginTransaction) await connection.beginTransaction();
    try {
      for (const statement of sql
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean))
        await connection.query(statement);
      await connection.query(
        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, UTC_TIMESTAMP(6))",
        [migration.version, migration.name],
      );
      if (connection.commit) await connection.commit();
    } catch (error) {
      if (connection.rollback) await connection.rollback();
      throw error;
    }
  }
  return {
    fromVersion: state.version,
    toVersion: state.latest,
    appliedVersions: state.pending.map((migration) => migration.version),
  };
}

export async function assertMysqlSchemaCurrent(
  connection: MysqlConnection,
): Promise<void> {
  const state = await inspectMysqlSchema(connection);
  if (state.pending.length)
    throw new Error(
      `MySQL migrations are pending (${state.version}/${state.latest}).`,
    );
}

export async function createMysqlConnection(
  url: string,
  options: {
    ssl?: { ca?: string; rejectUnauthorized: true; verifyIdentity?: true };
    connectTimeout?: number;
  } = {},
): Promise<MysqlConnection> {
  const importer = Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<{
    createConnection: (
      options: string | { uri: string; dateStrings: boolean },
    ) => Promise<MysqlConnection>;
  }>;
  const { createConnection } = await importer("mysql2/promise");
  return createConnection({ uri: url, dateStrings: true, ...options });
}
