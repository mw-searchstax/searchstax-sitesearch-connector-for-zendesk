import { describe, expect, it } from "vitest";

import {
  applyMysqlMigrations,
  assertMysqlSchemaCurrent,
  inspectMysqlSchema,
  mysqlMigrations,
  type MysqlConnection,
} from "./mysql-schema.ts";

class FakeMysql implements MysqlConnection {
  version: number | null;
  readonly queries: string[] = [];

  constructor(version: number | null = null) {
    this.version = version;
  }

  async query<T = unknown>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<[T, unknown]> {
    this.queries.push(sql);
    if (/SELECT COALESCE\(MAX\(version\)/u.test(sql)) {
      if (this.version === null)
        throw new Error("Table 'test.schema_migrations' doesn't exist");
      return [[{ version: this.version }] as T, undefined];
    }
    if (/INSERT INTO schema_migrations/u.test(sql)) {
      this.version = Number(values?.[0]);
    }
    return [[] as T, undefined];
  }
}

describe("MySQL schema control", () => {
  it("has explicit ordered migrations and connector-scoped schema", async () => {
    const migrations = await mysqlMigrations();
    expect(migrations.map(({ version }) => version)).toEqual([1, 2, 3]);
    const sql = await Promise.all(
      migrations.map(async ({ path }) =>
        (await import("node:fs/promises")).readFile(path, "utf8"),
      ),
    );
    const schema = sql.join("\n");
    expect(schema).toContain("ENGINE=InnoDB");
    expect(schema).toContain("PRIMARY KEY (connector_id)");
    expect(schema).toContain("PRIMARY KEY (connector_id, id)");
    expect(schema).toContain("document_json LONGTEXT");
    expect(schema).not.toMatch(/document_json[^\n]*JSON/u);
    expect(schema).toContain("CONSTRAINT telemetry_run_fk");
    expect(schema).not.toContain("first_seen_run_fk");
  });

  it("applies clean migrations in order and rejects pending or future schemas", async () => {
    const clean = new FakeMysql();
    await expect(applyMysqlMigrations(clean)).resolves.toMatchObject({
      appliedVersions: [1, 2, 3],
    });
    expect(clean.version).toBe(3);
    await expect(assertMysqlSchemaCurrent(new FakeMysql(2))).rejects.toThrow(
      "migrations are pending",
    );
    await expect(inspectMysqlSchema(new FakeMysql(99))).rejects.toThrow(
      "newer than application",
    );
  });

  it("uses binary machine-identifier semantics and per-connector singleton keys", async () => {
    const migrations = await mysqlMigrations();
    const schema = await (
      await import("node:fs/promises")
    ).readFile(migrations[1]!.path, "utf8");
    expect(schema).toContain("COLLATE utf8mb4_bin");
    expect(schema).toContain(
      "PRIMARY KEY (connector_id, run_id, destination_id)",
    );
    expect(schema).toContain("UNIQUE KEY manifest_source_uq (connector_id");
    expect(schema).toContain("PRIMARY KEY (connector_id),");
  });

  it("defines the OAuth compatibility gate while retaining opaque envelopes", async () => {
    const migrations = await mysqlMigrations();
    const sql = await (
      await import("node:fs/promises")
    ).readFile(migrations[2]!.path, "utf8");
    expect(sql).toContain("CREATE TABLE oauth_compatibility");
    expect(sql).toContain("legacy-or-oauth");
    expect(sql).not.toContain("credential_envelope_json");
  });

  it("keeps migration chunks executable after the MySQL splitter runs", async () => {
    const migrations = await mysqlMigrations();
    for (const migration of migrations) {
      const sql = await (
        await import("node:fs/promises")
      ).readFile(migration.path, "utf8");
      const chunks = sql
        .split(";")
        .map((part) => part.replace(/^\s*(?:--[^\n]*\n)*/gu, "").trim())
        .filter(Boolean);
      expect(chunks.length, migration.name).toBeGreaterThan(0);
      for (const chunk of chunks)
        expect(chunk, `${migration.name} chunk`).toMatch(
          /^(?:CREATE|INSERT|ALTER|UPDATE|DELETE|DROP)\s/iu,
        );
    }
  });
});
