import { describe, expect, it } from "vitest";

import { MysqlReconciliationStore } from "./mysql-store.ts";
import type { MysqlConnection } from "./mysql-schema.ts";

type CredentialRow = { revision: number; envelope: string };

class CasMysql implements MysqlConnection {
  readonly rows = new Map<string, CredentialRow>([
    ["primary", { revision: 4, envelope: "old-primary" }],
    ["other", { revision: 4, envelope: "old-other" }],
  ]);

  async query<T = unknown>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<[T, unknown]> {
    if (sql.includes("SELECT id FROM connector_identity")) {
      const connector = String(values?.[0]);
      return [
        [...(this.rows.has(connector) ? [{ id: connector }] : [])] as T,
        undefined,
      ];
    }
    if (sql.includes("UPDATE connector_config")) {
      const [newEnvelope, connector, revision, expectedEnvelope] = values ?? [];
      const row = this.rows.get(String(connector));
      const matched =
        row?.revision === Number(revision) &&
        row.envelope === String(expectedEnvelope);
      if (matched) row!.envelope = String(newEnvelope);
      return [{ affectedRows: matched ? 1 : 0 } as T, undefined];
    }
    return [{} as T, undefined];
  }

  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  async end() {}
}

describe("MySQL credential persistence", () => {
  it("atomically swaps only the expected connector revision and envelope", async () => {
    const database = new CasMysql();
    const primary = MysqlReconciliationStore.fromConnectionFactory(
      async () => database,
      "primary",
    );
    const other = MysqlReconciliationStore.fromConnectionFactory(
      async () => database,
      "other",
    );

    await expect(
      primary.compareAndSwapCredentials(4, "old-primary", "rotated-primary"),
    ).resolves.toBe(true);
    await expect(
      primary.compareAndSwapCredentials(4, "old-primary", "stale-primary"),
    ).resolves.toBe(false);
    await expect(
      primary.compareAndSwapCredentials(3, "rotated-primary", "wrong-revision"),
    ).resolves.toBe(false);
    await expect(
      other.compareAndSwapCredentials(4, "old-primary", "cross-connector"),
    ).resolves.toBe(false);

    expect(database.rows).toEqual(
      new Map([
        ["primary", { revision: 4, envelope: "rotated-primary" }],
        ["other", { revision: 4, envelope: "old-other" }],
      ]),
    );
  });
});
