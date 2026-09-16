import { randomUUID } from "node:crypto";
import { createMysqlConnection, type MysqlConnection } from "./mysql-schema.ts";
import type {
  ManifestRecord,
  RunCounts,
  RunRecord,
  RunState,
  StagedRecord,
  DeletionPlan,
  QuarantinedRecord,
  TelemetryRecord,
} from "../worker/reconciliation/model.ts";
import { normalizeLocale, type Json } from "../worker/contracts/record.ts";
import type {
  ApplicationStateStore,
  StoredConfiguration,
  StoredIssue,
  StoredLocalePlan,
  StoredRun,
  StoredScheduler,
} from "./application-state.ts";

type Row = Record<string, unknown>;
type Connect = () => Promise<MysqlConnection>;

function number(row: Row, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value))
    throw new Error(`MySQL ${key} was invalid.`);
  return value;
}

function string(row: Row, key: string): string {
  if (typeof row[key] !== "string")
    throw new Error(`MySQL ${key} was invalid.`);
  return row[key] as string;
}

function counts(row: Row): RunCounts {
  return {
    source: number(row, "source_count"),
    created: number(row, "new_count"),
    changed: number(row, "changed_count"),
    unchanged: number(row, "unchanged_count"),
    stale: number(row, "stale_count"),
    plannedDeletions: number(row, "planned_deletion_count"),
    successfulDeletions: number(row, "successful_deletion_count"),
    failedDeletions: number(row, "failed_deletion_count"),
    withheldDeletions: number(row, "withheld_deletion_count"),
    warnings: number(row, "warning_count"),
    quarantined: number(row, "quarantine_count"),
  };
}

function run(row: Row): RunRecord {
  return {
    id: string(row, "id"),
    workflowId: string(row, "workflow_id"),
    configRevision: number(row, "config_revision"),
    state: string(row, "state") as RunState,
    counts: counts(row),
    ...(typeof row.failure_code === "string"
      ? { failureCode: row.failure_code }
      : {}),
  };
}

function storedRun(row: Row): StoredRun {
  return {
    ...run(row),
    startedAt: mysqlTimestamp(row.started_at),
    ...(typeof row.finished_at === "string"
      ? { finishedAt: mysqlTimestamp(row.finished_at) }
      : {}),
    updatedAt: mysqlTimestamp(row.updated_at),
    ...(typeof row.deletion_plan_id === "string" &&
    typeof row.deletion_exact_ids === "string" &&
    typeof row.deletion_fingerprint === "string" &&
    Number.isSafeInteger(Number(row.deletion_stale_count))
      ? {
          deletionPlan: {
            id: row.deletion_plan_id,
            staleCount: Number(row.deletion_stale_count),
            exactIds: JSON.parse(string(row, "deletion_exact_ids")) as string[],
            fingerprint: row.deletion_fingerprint,
          },
        }
      : {}),
  };
}

function resultChanges(result: unknown): number {
  return Number(
    (result as { affectedRows?: number; changes?: number }).affectedRows ??
      (result as { changes?: number }).changes ??
      0,
  );
}

function deadlock(error: unknown): boolean {
  const candidate = error as { code?: string; errno?: number };
  return candidate.code === "ER_LOCK_DEADLOCK" || candidate.errno === 1213;
}

function mysqlDate(value: string): string {
  const sql = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/u.exec(
    value,
  );
  if (sql)
    return `${sql[1]} ${sql[2]}.${(sql[3] ?? "").slice(0, 6).padEnd(6, "0")}`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed
    .toISOString()
    .replace("T", " ")
    .replace("Z", "")
    .replace(/(\.\d{3})$/u, "$1000");
}

function mysqlTimestamp(value: unknown): string {
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/u.exec(
    text,
  );
  if (!match) return text;
  const milliseconds = (match[3] ?? "").slice(0, 3).padEnd(3, "0");
  const parsed = new Date(`${match[1]}T${match[2]}.${milliseconds}Z`);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

const RETENTION_MILLISECONDS = 90 * 24 * 60 * 60 * 1_000;
const MAX_RETAINED_RUNS = 2_500;

/** Concrete, connector-bound MySQL application persistence. */
export class MysqlReconciliationStore implements ApplicationStateStore {
  private constructor(
    private readonly connect: Connect,
    private readonly connector: string,
    private readonly clock: () => string,
    private readonly maxAttempts: number,
  ) {
    if (!connector) throw new Error("MySQL connector identity was missing.");
  }

  static fromConnectionFactory(
    connect: Connect,
    connectorId: string,
    clock = () => new Date().toISOString(),
    maxAttempts = 3,
  ) {
    return new MysqlReconciliationStore(
      connect,
      connectorId,
      clock,
      maxAttempts,
    );
  }

  static fromUrl(
    url: string,
    connectorId: string,
    clock = () => new Date().toISOString(),
  ) {
    return MysqlReconciliationStore.fromConnectionFactory(
      () => createMysqlConnection(url),
      connectorId,
      clock,
    );
  }

  private async transaction<T>(
    operation: (connection: MysqlConnection) => Promise<T>,
  ) {
    for (let attempt = 1; ; attempt += 1) {
      const connection = await this.connect();
      try {
        await connection.beginTransaction?.();
        // Every connector-sensitive write starts here. All other locks follow
        // connector -> config -> manifest -> active_run -> affected rows.
        const [roots] = await connection.query<Row[]>(
          "SELECT id FROM connector_identity WHERE id = ? FOR UPDATE",
          [this.connector],
        );
        if (!roots.length)
          throw new Error("MySQL connector identity was missing.");
        const value = await operation(connection);
        await connection.commit?.();
        await connection.end?.();
        return value;
      } catch (error) {
        try {
          await connection.rollback?.();
        } finally {
          await connection.end?.();
        }
        if (deadlock(error) && attempt < this.maxAttempts) continue;
        throw error;
      }
    }
  }

  private async read<T>(
    operation: (connection: MysqlConnection) => Promise<T>,
  ) {
    const connection = await this.connect();
    try {
      return await operation(connection);
    } finally {
      await connection.end?.();
    }
  }

  async ensureConnector() {
    const connection = await this.connect();
    try {
      await connection.beginTransaction?.();
      await connection.query(
        "INSERT IGNORE INTO connector_identity(id, created_at) VALUES (?, UTC_TIMESTAMP(6))",
        [this.connector],
      );
      await connection.query(
        "INSERT IGNORE INTO manifest_meta(connector_id, revision) VALUES (?, 0)",
        [this.connector],
      );
      await connection.query(
        `INSERT IGNORE INTO scheduler_state(
          connector_id, state, next_due_at, retry_attempt, pause_reason, updated_at
        ) VALUES (?, 'disabled', NULL, 0, NULL, UTC_TIMESTAMP(6))`,
        [this.connector],
      );
      await connection.commit?.();
    } catch (error) {
      await connection.rollback?.();
      throw error;
    } finally {
      await connection.end?.();
    }
  }

  async saveConfiguration(configuration: StoredConfiguration) {
    await this.transaction(async (connection) => {
      await connection.query(
        `INSERT INTO connector_config(
          connector_id, revision, state, connector_key, brand_id, brand_name,
          brand_subdomain, selected_locales_json, destination_name, preview_url,
          execution_target, credential_envelope_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE revision = VALUES(revision), state = VALUES(state),
          connector_key = VALUES(connector_key), brand_id = VALUES(brand_id),
          brand_name = VALUES(brand_name), brand_subdomain = VALUES(brand_subdomain),
          selected_locales_json = VALUES(selected_locales_json), destination_name = VALUES(destination_name),
          preview_url = VALUES(preview_url), execution_target = VALUES(execution_target),
          credential_envelope_json = VALUES(credential_envelope_json), created_at = VALUES(created_at),
          updated_at = VALUES(updated_at)`,
        [
          this.connector,
          configuration.revision,
          configuration.state,
          configuration.connectorKey,
          configuration.brandId,
          configuration.brandName,
          configuration.brandSubdomain,
          JSON.stringify(configuration.selectedLocales),
          configuration.destinationName,
          configuration.previewUrl ?? null,
          configuration.target,
          configuration.credentialEnvelope,
          mysqlDate(configuration.createdAt),
          mysqlDate(configuration.updatedAt),
        ],
      );
    });
  }

  async compareAndSwapCredentials(
    expectedRevision: number,
    expectedEnvelope: string,
    newEnvelope: string,
  ) {
    return this.transaction(async (connection) => {
      const [result] = await connection.query<unknown>(
        `UPDATE connector_config
         SET credential_envelope_json = ?
         WHERE connector_id = ? AND revision = ? AND credential_envelope_json = ?`,
        [newEnvelope, this.connector, expectedRevision, expectedEnvelope],
      );
      return resultChanges(result) === 1;
    });
  }

  async configuration(): Promise<StoredConfiguration | null> {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        "SELECT * FROM connector_config WHERE connector_id = ?",
        [this.connector],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        revision: number(row, "revision"),
        state: string(row, "state") as StoredConfiguration["state"],
        connectorKey: string(row, "connector_key"),
        brandId: string(row, "brand_id"),
        brandName: string(row, "brand_name"),
        brandSubdomain: string(row, "brand_subdomain"),
        selectedLocales: JSON.parse(
          string(row, "selected_locales_json"),
        ) as string[],
        destinationName: string(row, "destination_name"),
        ...(typeof row.preview_url === "string"
          ? { previewUrl: row.preview_url }
          : {}),
        target: string(
          row,
          "execution_target",
        ) as StoredConfiguration["target"],
        credentialEnvelope: string(row, "credential_envelope_json"),
        createdAt: mysqlTimestamp(row.created_at),
        updatedAt: mysqlTimestamp(row.updated_at),
      };
    });
  }

  async configurationRevision() {
    const configuration = await this.configuration();
    if (!configuration) throw new Error("Connector configuration was missing.");
    return configuration.revision;
  }

  async recoveryAvailable() {
    return this.read(async (connection) => {
      for (const table of [
        "connector_config",
        "runs",
        "active_run",
        "staged_records",
        "manifest",
        "deletion_plans",
        "locale_change_plans",
        "issues",
        "telemetry",
        "pending_probes",
      ]) {
        const [rows] = await connection.query<Row[]>(
          `SELECT 1 AS present FROM ${table} WHERE connector_id = ? LIMIT 1`,
          [this.connector],
        );
        if (rows.length) return false;
      }
      return true;
    });
  }

  async adoptNamespace(
    configuration: StoredConfiguration,
    records: readonly StagedRecord[],
    runId: string,
    observedAt: string,
  ) {
    await this.transaction(async (connection) => {
      if (!(await this.recoveryEmpty(connection)))
        throw new Error("Namespace recovery requires empty local state.");
      await connection.query(
        `INSERT INTO connector_config(
          connector_id, revision, state, connector_key, brand_id, brand_name,
          brand_subdomain, selected_locales_json, destination_name, preview_url,
          execution_target, credential_envelope_json, created_at, updated_at
        ) VALUES (?, ?, 'locked_after_first_success', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.connector,
          configuration.revision,
          configuration.connectorKey,
          configuration.brandId,
          configuration.brandName,
          configuration.brandSubdomain,
          JSON.stringify(configuration.selectedLocales),
          configuration.destinationName,
          configuration.previewUrl ?? null,
          configuration.target,
          configuration.credentialEnvelope,
          mysqlDate(configuration.createdAt),
          mysqlDate(observedAt),
        ],
      );
      await this.insertRun(
        connection,
        {
          id: runId,
          workflowId: `recovery-${runId}`,
          configRevision: configuration.revision,
          state: "succeeded",
          counts: {
            source: records.length,
            created: 0,
            changed: 0,
            unchanged: records.length,
            stale: 0,
            plannedDeletions: 0,
            successfulDeletions: 0,
            failedDeletions: 0,
            withheldDeletions: 0,
            warnings: records.filter((record) => record.warnings.length).length,
            quarantined: 0,
          },
        },
        observedAt,
        connection,
      );
      for (const record of records)
        await connection.query(
          `INSERT INTO manifest(
            connector_id, destination_id, source_subdomain, article_id, translation_id,
            locale, source_updated_at, content_hash, last_seen_run_id, acknowledged_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            this.connector,
            record.destinationId,
            record.sourceIdentity.subdomain,
            record.articleId,
            record.translationId,
            record.locale,
            mysqlDate(record.sourceUpdatedAt),
            record.hash,
            runId,
            mysqlDate(observedAt),
          ],
        );
      if (records.length)
        await connection.query(
          "UPDATE manifest_meta SET revision = revision + 1 WHERE connector_id = ?",
          [this.connector],
        );
      await connection.query(
        `INSERT INTO telemetry(connector_id, run_id, phase, event, visibility, record_count, created_at)
         VALUES (?, ?, 'recovery', 'namespace_adopted', 'operator', ?, ?)`,
        [this.connector, runId, records.length, mysqlDate(observedAt)],
      );
    });
  }

  private async recoveryEmpty(connection: MysqlConnection) {
    for (const table of [
      "connector_config",
      "runs",
      "active_run",
      "staged_records",
      "manifest",
      "deletion_plans",
      "locale_change_plans",
      "issues",
      "telemetry",
      "pending_probes",
    ]) {
      const [rows] = await connection.query<Row[]>(
        `SELECT 1 AS present FROM ${table} WHERE connector_id = ? LIMIT 1`,
        [this.connector],
      );
      if (rows.length) return false;
    }
    return true;
  }

  private async insertRun(
    connection: MysqlConnection,
    value: RunRecord,
    timestamp: string,
    existingConnection?: MysqlConnection,
  ) {
    const target = existingConnection ?? connection;
    const c = value.counts;
    await target.query(
      `INSERT INTO runs(
        connector_id, id, workflow_id, config_revision, state, started_at, updated_at,
        source_count, new_count, changed_count, unchanged_count, stale_count,
        planned_deletion_count, successful_deletion_count, failed_deletion_count,
        withheld_deletion_count, warning_count, quarantine_count, failure_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.connector,
        value.id,
        value.workflowId,
        value.configRevision,
        value.state,
        mysqlDate(timestamp),
        mysqlDate(timestamp),
        c.source,
        c.created,
        c.changed,
        c.unchanged,
        c.stale,
        c.plannedDeletions,
        c.successfulDeletions,
        c.failedDeletions,
        c.withheldDeletions,
        c.warnings,
        c.quarantined,
        value.failureCode ?? null,
      ],
    );
  }

  async admitRun(value: RunRecord) {
    return this.transaction(async (connection) => {
      const [active] = await connection.query<Row[]>(
        "SELECT run_id FROM active_run WHERE connector_id = ? FOR UPDATE",
        [this.connector],
      );
      if (active.length) return false;
      await this.insertRun(connection, value, this.clock());
      await connection.query(
        "INSERT INTO active_run(connector_id, run_id) VALUES (?, ?)",
        [this.connector, value.id],
      );
      return true;
    });
  }

  async activeRun() {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        `SELECT runs.* FROM runs JOIN active_run
         ON active_run.connector_id = runs.connector_id AND active_run.run_id = runs.id
         WHERE active_run.connector_id = ?`,
        [this.connector],
      );
      return rows[0] ? run(rows[0]) : null;
    });
  }

  async run(runId: string) {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        "SELECT * FROM runs WHERE connector_id = ? AND id = ?",
        [this.connector, runId],
      );
      return rows[0] ? run(rows[0]) : null;
    });
  }

  async runDetails(runId: string): Promise<StoredRun | null> {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        `SELECT runs.*, deletion_plans.id AS deletion_plan_id,
         deletion_plans.exact_ids_json AS deletion_exact_ids,
         deletion_plans.fingerprint AS deletion_fingerprint,
         deletion_plans.stale_count AS deletion_stale_count
         FROM runs LEFT JOIN deletion_plans ON deletion_plans.connector_id = runs.connector_id
         AND deletion_plans.run_id = runs.id
         AND deletion_plans.state = 'pending'
         WHERE runs.connector_id = ? AND runs.id = ?`,
        [this.connector, runId],
      );
      return rows[0] ? storedRun(rows[0]) : null;
    });
  }

  async activeRunDetails(): Promise<StoredRun | null> {
    const active = await this.activeRun();
    return active ? this.runDetails(active.id) : null;
  }

  async runHistory(before?: {
    startedAt: string;
    id: string;
  }): Promise<StoredRun[]> {
    const statement = before
      ? `SELECT runs.*, deletion_plans.id AS deletion_plan_id,
         deletion_plans.exact_ids_json AS deletion_exact_ids,
         deletion_plans.fingerprint AS deletion_fingerprint,
         deletion_plans.stale_count AS deletion_stale_count
         FROM runs LEFT JOIN deletion_plans ON deletion_plans.connector_id = runs.connector_id
         AND deletion_plans.run_id = runs.id
         AND deletion_plans.state = 'pending'
         WHERE runs.connector_id = ?
         AND (runs.started_at < ? OR (runs.started_at = ? AND runs.id < ?))
         ORDER BY runs.started_at DESC, runs.id DESC LIMIT 26`
      : `SELECT runs.*, deletion_plans.id AS deletion_plan_id,
         deletion_plans.exact_ids_json AS deletion_exact_ids,
         deletion_plans.fingerprint AS deletion_fingerprint,
         deletion_plans.stale_count AS deletion_stale_count
         FROM runs LEFT JOIN deletion_plans ON deletion_plans.connector_id = runs.connector_id
         AND deletion_plans.run_id = runs.id
         AND deletion_plans.state = 'pending'
         WHERE runs.connector_id = ?
         ORDER BY runs.started_at DESC, runs.id DESC LIMIT 26`;
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        statement,
        before
          ? [
              this.connector,
              mysqlDate(before.startedAt),
              mysqlDate(before.startedAt),
              before.id,
            ]
          : [this.connector],
      );
      return rows.map(storedRun);
    });
  }

  async updateRun(
    runId: string,
    state: RunState,
    values?: RunCounts,
    failureCode?: string,
  ) {
    const current = values ?? (await this.run(runId))?.counts;
    if (!current) throw new Error("Run was missing.");
    await this.transaction(async (connection) => {
      await connection.query(
        "SELECT id FROM runs WHERE connector_id = ? AND id = ? FOR UPDATE",
        [this.connector, runId],
      );
      await connection.query(
        `UPDATE runs SET state = ?, updated_at = ?, source_count = ?, new_count = ?, changed_count = ?,
         unchanged_count = ?, stale_count = ?, planned_deletion_count = ?, successful_deletion_count = ?,
         failed_deletion_count = ?, withheld_deletion_count = ?, warning_count = ?, quarantine_count = ?,
         failure_code = COALESCE(?, failure_code) WHERE connector_id = ? AND id = ?`,
        [
          state,
          mysqlDate(this.clock()),
          current.source,
          current.created,
          current.changed,
          current.unchanged,
          current.stale,
          current.plannedDeletions,
          current.successfulDeletions,
          current.failedDeletions,
          current.withheldDeletions,
          current.warnings,
          current.quarantined,
          failureCode ?? null,
          this.connector,
          runId,
        ],
      );
    });
  }

  async requestCancellation(runId: string) {
    return this.transaction(async (connection) => {
      const [active] = await connection.query<Row[]>(
        "SELECT run_id FROM active_run WHERE connector_id = ? FOR UPDATE",
        [this.connector],
      );
      if (active[0]?.run_id !== runId) return false;
      const [result] = await connection.query<unknown>(
        `UPDATE runs SET state = 'cancel_requested', updated_at = ? WHERE connector_id = ? AND id = ?
         AND state NOT IN ('succeeded','completed_with_errors','degraded','canceled','failed','abandoned')`,
        [mysqlDate(this.clock()), this.connector, runId],
      );
      return resultChanges(result) === 1;
    });
  }

  async abandonRun(runId: string, failureCode = "ABANDONED_WORKFLOW") {
    await this.transaction(async (connection) => {
      await connection.query(
        "SELECT run_id FROM active_run WHERE connector_id = ? FOR UPDATE",
        [this.connector],
      );
      await connection.query(
        "SELECT id FROM runs WHERE connector_id = ? AND id = ? FOR UPDATE",
        [this.connector, runId],
      );
      const timestamp = mysqlDate(this.clock());
      await connection.query(
        "UPDATE runs SET state = 'abandoned', updated_at = ?, finished_at = ?, failure_code = ? WHERE connector_id = ? AND id = ?",
        [timestamp, timestamp, failureCode, this.connector, runId],
      );
      await connection.query(
        "DELETE FROM staged_records WHERE connector_id = ? AND run_id = ?",
        [this.connector, runId],
      );
      await connection.query(
        "DELETE FROM active_run WHERE connector_id = ? AND run_id = ?",
        [this.connector, runId],
      );
    });
  }

  async finish(
    runId: string,
    state:
      | "succeeded"
      | "completed_with_errors"
      | "degraded"
      | "canceled"
      | "failed",
  ) {
    await this.transaction(async (connection) => {
      await connection.query(
        "SELECT connector_id FROM connector_config WHERE connector_id = ? FOR UPDATE",
        [this.connector],
      );
      await connection.query(
        "SELECT run_id FROM active_run WHERE connector_id = ? FOR UPDATE",
        [this.connector],
      );
      await connection.query(
        "SELECT id FROM runs WHERE connector_id = ? AND id = ? FOR UPDATE",
        [this.connector, runId],
      );
      const timestamp = mysqlDate(this.clock());
      await connection.query(
        "UPDATE runs SET state = ?, updated_at = ?, finished_at = ? WHERE connector_id = ? AND id = ?",
        [state, timestamp, timestamp, this.connector, runId],
      );
      await connection.query(
        "DELETE FROM staged_records WHERE connector_id = ? AND run_id = ?",
        [this.connector, runId],
      );
      if (["succeeded", "completed_with_errors", "degraded"].includes(state))
        await connection.query(
          "UPDATE connector_config SET state = 'locked_after_first_success', updated_at = ? WHERE connector_id = ? AND state = 'ready'",
          [timestamp, this.connector],
        );
      await connection.query(
        "DELETE FROM active_run WHERE connector_id = ? AND run_id = ?",
        [this.connector, runId],
      );
    });
  }

  async clearStaging(runId: string) {
    await this.transaction(async (connection) => {
      await connection.query(
        "SELECT run_id FROM active_run WHERE connector_id = ? FOR UPDATE",
        [this.connector],
      );
      await connection.query(
        "SELECT id FROM runs WHERE connector_id = ? AND id = ? FOR UPDATE",
        [this.connector, runId],
      );
      await connection.query(
        "DELETE FROM staged_records WHERE connector_id = ? AND run_id = ?",
        [this.connector, runId],
      );
    });
  }

  async stage(runId: string, records: readonly StagedRecord[]) {
    if (!records.length) return;
    await this.transaction(async (connection) => {
      await connection.query(
        "SELECT run_id FROM active_run WHERE connector_id = ? FOR UPDATE",
        [this.connector],
      );
      await connection.query(
        "SELECT id FROM runs WHERE connector_id = ? AND id = ? FOR UPDATE",
        [this.connector, runId],
      );
      for (const record of records)
        await connection.query(
          `INSERT INTO staged_records(
            connector_id, run_id, destination_id, source_subdomain, article_id, translation_id, locale,
            source_updated_at, content_hash, document_json, byte_size, warning_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            this.connector,
            runId,
            record.destinationId,
            record.sourceIdentity.subdomain,
            record.articleId,
            record.translationId,
            record.locale,
            mysqlDate(record.sourceUpdatedAt),
            record.hash,
            record.canonical,
            record.byteSize,
            record.warnings[0] ?? null,
          ],
        );
    });
  }

  async staged(runId: string) {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        `SELECT destination_id, source_subdomain, article_id, translation_id, locale,
         source_updated_at, content_hash, document_json, byte_size, warning_code
         FROM staged_records WHERE connector_id = ? AND run_id = ? ORDER BY destination_id`,
        [this.connector, runId],
      );
      return rows.map((row): StagedRecord => {
        const canonical = string(row, "document_json");
        return {
          id: string(row, "destination_id"),
          destinationId: string(row, "destination_id"),
          sourceIdentity: {
            subdomain: string(row, "source_subdomain"),
            articleId: string(row, "article_id"),
            locale: normalizeLocale(string(row, "locale")),
          },
          articleId: string(row, "article_id"),
          translationId: string(row, "translation_id"),
          locale: string(row, "locale"),
          sourceUpdatedAt: mysqlTimestamp(row.source_updated_at),
          hash: string(row, "content_hash"),
          canonical,
          document: JSON.parse(canonical) as Record<string, Json>,
          byteSize: number(row, "byte_size"),
          warnings: row.warning_code === "EMPTY_BODY" ? ["EMPTY_BODY"] : [],
        };
      });
    });
  }

  async manifest() {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        "SELECT * FROM manifest WHERE connector_id = ? ORDER BY destination_id",
        [this.connector],
      );
      return rows.map((row): ManifestRecord => ({
        destinationId: string(row, "destination_id"),
        sourceIdentity: {
          subdomain: string(row, "source_subdomain"),
          articleId: string(row, "article_id"),
          locale: normalizeLocale(string(row, "locale")),
        },
        translationId: string(row, "translation_id"),
        sourceUpdatedAt: mysqlTimestamp(row.source_updated_at),
        hash: string(row, "content_hash"),
        lastSeenRunId: string(row, "last_seen_run_id"),
        acknowledgedAt: mysqlTimestamp(row.acknowledged_at),
      }));
    });
  }

  async manifestRevision() {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        "SELECT revision FROM manifest_meta WHERE connector_id = ?",
        [this.connector],
      );
      if (!rows[0]) throw new Error("Manifest metadata was missing.");
      return number(rows[0], "revision");
    });
  }

  async acknowledge(
    runId: string,
    records: readonly StagedRecord[],
    acknowledgedAt: string,
  ) {
    if (!records.length) return;
    await this.transaction(async (connection) => {
      await connection.query(
        "SELECT revision FROM manifest_meta WHERE connector_id = ? FOR UPDATE",
        [this.connector],
      );
      for (const record of [...records].sort((a, b) =>
        a.destinationId.localeCompare(b.destinationId),
      ))
        await connection.query(
          `INSERT INTO manifest(
            connector_id, destination_id, source_subdomain, article_id, translation_id, locale,
            source_updated_at, content_hash, last_seen_run_id, acknowledged_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            destination_id = VALUES(destination_id), source_subdomain = VALUES(source_subdomain),
            article_id = VALUES(article_id), translation_id = VALUES(translation_id),
            locale = VALUES(locale), source_updated_at = VALUES(source_updated_at),
            content_hash = VALUES(content_hash), last_seen_run_id = VALUES(last_seen_run_id),
            acknowledged_at = VALUES(acknowledged_at)`,
          [
            this.connector,
            record.destinationId,
            record.sourceIdentity.subdomain,
            record.articleId,
            record.translationId,
            record.locale,
            mysqlDate(record.sourceUpdatedAt),
            record.hash,
            runId,
            mysqlDate(acknowledgedAt),
          ],
        );
      await connection.query(
        "UPDATE manifest_meta SET revision = revision + 1 WHERE connector_id = ?",
        [this.connector],
      );
    });
  }

  async markUnchanged(runId: string, ids: readonly string[]) {
    if (!ids.length) return;
    await this.transaction(async (connection) => {
      await connection.query(
        "SELECT revision FROM manifest_meta WHERE connector_id = ? FOR UPDATE",
        [this.connector],
      );
      for (const id of [...ids].sort()) {
        const [result] = await connection.query<unknown>(
          "UPDATE manifest SET last_seen_run_id = ? WHERE connector_id = ? AND destination_id = ?",
          [runId, this.connector, id],
        );
        if (resultChanges(result) !== 1)
          throw new Error("Manifest record was missing.");
      }
      await connection.query(
        "UPDATE manifest_meta SET revision = revision + 1 WHERE connector_id = ?",
        [this.connector],
      );
    });
  }

  async removeManifest(ids: readonly string[]) {
    if (!ids.length) return;
    await this.transaction(async (connection) => {
      await connection.query(
        "SELECT revision FROM manifest_meta WHERE connector_id = ? FOR UPDATE",
        [this.connector],
      );
      for (const id of [...ids].sort())
        await connection.query(
          "DELETE FROM manifest WHERE connector_id = ? AND destination_id = ?",
          [this.connector, id],
        );
      await connection.query(
        "UPDATE manifest_meta SET revision = revision + 1 WHERE connector_id = ?",
        [this.connector],
      );
    });
  }
  async scheduler(): Promise<StoredScheduler> {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        "SELECT * FROM scheduler_state WHERE connector_id = ?",
        [this.connector],
      );
      const row = rows[0];
      if (!row) throw new Error("MySQL scheduler state was missing.");
      return {
        state: string(row, "state") as StoredScheduler["state"],
        ...(row.next_due_at === null
          ? {}
          : { nextRunAt: mysqlTimestamp(row.next_due_at) }),
        retryAttempt: number(
          row,
          "retry_attempt",
        ) as StoredScheduler["retryAttempt"],
        ...(row.pause_reason === null
          ? {}
          : {
              pauseReason: string(
                row,
                "pause_reason",
              ) as StoredScheduler["pauseReason"],
            }),
        updatedAt: mysqlTimestamp(row.updated_at),
      };
    });
  }

  async saveScheduler(
    scheduler: Omit<StoredScheduler, "updatedAt">,
  ): Promise<StoredScheduler> {
    const updatedAt = this.clock();
    await this.transaction(async (connection) => {
      await connection.query(
        `INSERT INTO scheduler_state(
          connector_id, state, next_due_at, retry_attempt, pause_reason, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE state = VALUES(state), next_due_at = VALUES(next_due_at),
          retry_attempt = VALUES(retry_attempt), pause_reason = VALUES(pause_reason),
          updated_at = VALUES(updated_at)`,
        [
          this.connector,
          scheduler.state,
          scheduler.nextRunAt ? mysqlDate(scheduler.nextRunAt) : null,
          scheduler.retryAttempt,
          scheduler.pauseReason ?? null,
          mysqlDate(updatedAt),
        ],
      );
    });
    return { ...scheduler, updatedAt };
  }

  async pendingProbe() {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        "SELECT probe_id FROM pending_probes WHERE connector_id = ?",
        [this.connector],
      );
      return rows[0] ? string(rows[0], "probe_id") : null;
    });
  }

  async savePendingProbe(id: string) {
    await this.transaction(async (connection) => {
      await connection.query(
        `INSERT INTO pending_probes(connector_id, probe_id, created_at)
         VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE probe_id = VALUES(probe_id), created_at = VALUES(created_at)`,
        [this.connector, id, mysqlDate(this.clock())],
      );
    });
  }

  async clearPendingProbe(id: string) {
    await this.transaction(async (connection) => {
      await connection.query(
        "DELETE FROM pending_probes WHERE connector_id = ? AND probe_id = ?",
        [this.connector, id],
      );
    });
  }

  async saveLocalePlan(plan: StoredLocalePlan) {
    await this.transaction(async (connection) => {
      await connection.query(
        `INSERT INTO locale_change_plans(
          connector_id, id, config_revision, selected_locales_json, removed_record_count,
          fingerprint, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.connector,
          plan.id,
          plan.configRevision,
          JSON.stringify(plan.selectedLocales),
          plan.removedRecordCount,
          plan.fingerprint,
          plan.state,
          mysqlDate(plan.createdAt),
        ],
      );
    });
  }

  async localePlan(planId: string): Promise<StoredLocalePlan | null> {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        "SELECT * FROM locale_change_plans WHERE connector_id = ? AND id = ?",
        [this.connector, planId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: string(row, "id"),
        configRevision: number(row, "config_revision"),
        selectedLocales: JSON.parse(
          string(row, "selected_locales_json"),
        ) as string[],
        removedRecordCount: number(row, "removed_record_count"),
        fingerprint: string(row, "fingerprint"),
        state: string(row, "state") as StoredLocalePlan["state"],
        createdAt: mysqlTimestamp(row.created_at),
      };
    });
  }

  async applyLocalePlan(
    planId: string,
    fingerprint: string,
  ): Promise<"applied" | "stale"> {
    return this.transaction(async (connection) => {
      await connection.query(
        "SELECT connector_id FROM connector_config WHERE connector_id = ? FOR UPDATE",
        [this.connector],
      );
      const [rows] = await connection.query<Row[]>(
        `SELECT * FROM locale_change_plans
         WHERE connector_id = ? AND id = ? AND state = 'pending' FOR UPDATE`,
        [this.connector, planId],
      );
      const plan = rows[0];
      if (!plan || string(plan, "fingerprint") !== fingerprint) return "stale";
      const [result] = await connection.query<unknown>(
        `UPDATE connector_config SET selected_locales_json = ?, revision = revision + 1,
         updated_at = ? WHERE connector_id = ? AND revision = ?`,
        [
          string(plan, "selected_locales_json"),
          mysqlDate(this.clock()),
          this.connector,
          number(plan, "config_revision"),
        ],
      );
      if (resultChanges(result) !== 1) {
        await connection.query(
          "UPDATE locale_change_plans SET state = 'invalidated' WHERE connector_id = ? AND id = ?",
          [this.connector, planId],
        );
        return "stale";
      }
      await connection.query(
        "UPDATE locale_change_plans SET state = 'applied' WHERE connector_id = ? AND id = ?",
        [this.connector, planId],
      );
      return "applied";
    });
  }

  async syncIssues(
    runId: string,
    locales: readonly string[],
    records: readonly QuarantinedRecord[],
    observedAt: string,
  ) {
    await this.transaction(async (connection) => {
      const current = new Set(
        records.map((record) =>
          JSON.stringify([record.articleId, record.locale, record.reasonCode]),
        ),
      );
      const [active] = await connection.query<Row[]>(
        "SELECT article_id, locale, reason_code FROM issues WHERE connector_id = ? AND state = 'active'",
        [this.connector],
      );
      for (const issue of active) {
        const key = JSON.stringify([
          string(issue, "article_id"),
          string(issue, "locale"),
          string(issue, "reason_code"),
        ]);
        if (locales.includes(string(issue, "locale")) && !current.has(key))
          await connection.query(
            `UPDATE issues SET state = 'resolved', resolved_at = ?
             WHERE connector_id = ? AND article_id = ? AND locale = ? AND reason_code = ?`,
            [
              mysqlDate(observedAt),
              this.connector,
              string(issue, "article_id"),
              string(issue, "locale"),
              string(issue, "reason_code"),
            ],
          );
      }
      for (const record of records)
        await connection.query(
          `INSERT INTO issues(
            connector_id, id, stable_id, article_id, locale, public_title, public_url,
            reason_code, state, first_seen_run_id, last_seen_run_id,
            first_seen_at, last_seen_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL)
          ON DUPLICATE KEY UPDATE stable_id = VALUES(stable_id), public_title = VALUES(public_title),
            public_url = VALUES(public_url), state = 'active', last_seen_run_id = VALUES(last_seen_run_id),
            last_seen_at = VALUES(last_seen_at), resolved_at = NULL`,
          [
            this.connector,
            randomUUID(),
            record.id,
            record.articleId,
            record.locale,
            record.publicTitle,
            record.publicUrl,
            record.reasonCode,
            runId,
            runId,
            mysqlDate(observedAt),
            mysqlDate(observedAt),
          ],
        );
    });
  }

  async quarantined(runId: string): Promise<QuarantinedRecord[]> {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        `SELECT stable_id, article_id, locale, public_title, public_url, reason_code
         FROM issues WHERE connector_id = ? AND last_seen_run_id = ? AND stable_id IS NOT NULL
         ORDER BY stable_id, reason_code`,
        [this.connector, runId],
      );
      return rows.map((row) => ({
        id: string(row, "stable_id"),
        articleId: string(row, "article_id"),
        locale: string(row, "locale"),
        publicTitle: string(row, "public_title"),
        publicUrl: string(row, "public_url"),
        reasonCode: string(row, "reason_code"),
      }));
    });
  }

  async saveIssue(issue: StoredIssue) {
    await this.transaction(async (connection) => {
      await connection.query(
        `INSERT INTO issues(
          connector_id, id, article_id, locale, public_title, public_url, reason_code, state,
          first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE public_title = VALUES(public_title), public_url = VALUES(public_url),
          state = VALUES(state), last_seen_run_id = VALUES(last_seen_run_id),
          last_seen_at = VALUES(last_seen_at), resolved_at = VALUES(resolved_at)`,
        [
          this.connector,
          issue.id,
          issue.articleId,
          issue.locale,
          issue.publicTitle,
          issue.publicUrl,
          issue.reasonCode,
          issue.state,
          issue.firstSeenRunId,
          issue.lastSeenRunId,
          mysqlDate(issue.firstSeenAt),
          mysqlDate(issue.lastSeenAt),
          issue.resolvedAt ? mysqlDate(issue.resolvedAt) : null,
        ],
      );
    });
  }

  async issues(): Promise<StoredIssue[]> {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        "SELECT * FROM issues WHERE connector_id = ? ORDER BY last_seen_at DESC, id",
        [this.connector],
      );
      return rows.map((row) => ({
        id: string(row, "id"),
        articleId: string(row, "article_id"),
        locale: string(row, "locale"),
        publicTitle: string(row, "public_title"),
        publicUrl: string(row, "public_url"),
        reasonCode: string(row, "reason_code"),
        state: string(row, "state") as StoredIssue["state"],
        firstSeenRunId: string(row, "first_seen_run_id"),
        lastSeenRunId: string(row, "last_seen_run_id"),
        firstSeenAt: mysqlTimestamp(row.first_seen_at),
        lastSeenAt: mysqlTimestamp(row.last_seen_at),
        ...(typeof row.resolved_at === "string"
          ? { resolvedAt: mysqlTimestamp(row.resolved_at) }
          : {}),
      }));
    });
  }

  async appendTelemetry(event: TelemetryRecord) {
    await this.transaction(async (connection) => {
      await connection.query(
        `INSERT INTO telemetry(
          connector_id, run_id, phase, event, visibility, attempt, batch_number,
          record_count, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.connector,
          event.runId,
          event.phase,
          event.event,
          event.visibility,
          event.attempt ?? null,
          event.batchNumber ?? null,
          event.recordCount ?? null,
          event.durationMs ?? null,
          mysqlDate(event.createdAt),
        ],
      );
    });
  }

  async telemetry(runId: string): Promise<TelemetryRecord[]> {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        "SELECT * FROM telemetry WHERE connector_id = ? AND run_id = ? ORDER BY created_at, id",
        [this.connector, runId],
      );
      return rows.map((row) => ({
        runId: string(row, "run_id"),
        phase: string(row, "phase"),
        event: string(row, "event"),
        visibility: string(row, "visibility") as TelemetryRecord["visibility"],
        ...(row.attempt === null ? {} : { attempt: number(row, "attempt") }),
        ...(row.batch_number === null
          ? {}
          : { batchNumber: number(row, "batch_number") }),
        ...(row.record_count === null
          ? {}
          : { recordCount: number(row, "record_count") }),
        ...(row.duration_ms === null
          ? {}
          : { durationMs: number(row, "duration_ms") }),
        createdAt: mysqlTimestamp(row.created_at),
      }));
    });
  }

  async incidents(): Promise<TelemetryRecord[]> {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        `SELECT * FROM telemetry WHERE connector_id = ? AND visibility = 'operator'
         ORDER BY created_at DESC, id DESC LIMIT 25`,
        [this.connector],
      );
      return rows.map((row) => ({
        runId: string(row, "run_id"),
        phase: string(row, "phase"),
        event: string(row, "event"),
        visibility: "operator" as const,
        ...(row.attempt === null ? {} : { attempt: number(row, "attempt") }),
        ...(row.batch_number === null
          ? {}
          : { batchNumber: number(row, "batch_number") }),
        ...(row.record_count === null
          ? {}
          : { recordCount: number(row, "record_count") }),
        ...(row.duration_ms === null
          ? {}
          : { durationMs: number(row, "duration_ms") }),
        createdAt: mysqlTimestamp(row.created_at),
      }));
    });
  }

  async saveDeletionPlan(plan: DeletionPlan) {
    await this.transaction(async (connection) => {
      await connection.query(
        `INSERT INTO deletion_plans(
          connector_id, id, run_id, exact_ids_json, stale_count, config_revision,
          manifest_revision, manifest_fingerprint, source_fingerprint,
          destination_fingerprint, fingerprint, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.connector,
          plan.id,
          plan.runId,
          JSON.stringify(plan.exactIds),
          plan.exactIds.length,
          plan.configRevision,
          plan.manifestRevision,
          plan.manifestFingerprint,
          plan.sourceFingerprint,
          plan.destinationFingerprint,
          plan.fingerprint,
          plan.state,
          mysqlDate(this.clock()),
        ],
      );
    });
  }

  async deletionPlan(planId: string): Promise<DeletionPlan | null> {
    return this.read(async (connection) => {
      const [rows] = await connection.query<Row[]>(
        "SELECT * FROM deletion_plans WHERE connector_id = ? AND id = ?",
        [this.connector, planId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: string(row, "id"),
        runId: string(row, "run_id"),
        exactIds: JSON.parse(string(row, "exact_ids_json")) as string[],
        configRevision: number(row, "config_revision"),
        manifestRevision: number(row, "manifest_revision"),
        manifestFingerprint: string(row, "manifest_fingerprint"),
        sourceFingerprint: string(row, "source_fingerprint"),
        destinationFingerprint: string(row, "destination_fingerprint"),
        fingerprint: string(row, "fingerprint"),
        state: string(row, "state") as DeletionPlan["state"],
      };
    });
  }

  async updateDeletionPlan(planId: string, state: DeletionPlan["state"]) {
    await this.transaction(async (connection) => {
      const [result] = await connection.query<unknown>(
        `UPDATE deletion_plans SET state = ?,
         confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_at END
         WHERE connector_id = ? AND id = ?`,
        [state, state, mysqlDate(this.clock()), this.connector, planId],
      );
      if (resultChanges(result) !== 1)
        throw new Error("Deletion plan was missing.");
    });
  }

  async pruneHistory() {
    const now = Date.parse(this.clock());
    if (!Number.isFinite(now)) throw new Error("Retention clock was invalid.");
    const cutoff = mysqlDate(
      new Date(now - RETENTION_MILLISECONDS).toISOString(),
    );
    return this.transaction(async (connection) => {
      const before = await this.retentionCounts(connection);
      await connection.query(
        "DELETE FROM telemetry WHERE connector_id = ? AND created_at < ?",
        [this.connector, cutoff],
      );
      await connection.query(
        "DELETE FROM issues WHERE connector_id = ? AND state = 'resolved' AND last_seen_at < ?",
        [this.connector, cutoff],
      );
      await connection.query(
        `DELETE FROM runs WHERE connector_id = ? AND state IN
         ('succeeded', 'completed_with_errors', 'degraded', 'canceled', 'failed', 'abandoned')
         AND finished_at < ?
         AND NOT EXISTS (SELECT 1 FROM active_run WHERE active_run.connector_id = runs.connector_id AND active_run.run_id = runs.id)
         AND NOT EXISTS (SELECT 1 FROM manifest WHERE manifest.connector_id = runs.connector_id AND manifest.last_seen_run_id = runs.id)
         AND NOT EXISTS (SELECT 1 FROM deletion_plans WHERE deletion_plans.connector_id = runs.connector_id
                         AND deletion_plans.run_id = runs.id AND deletion_plans.state IN ('pending', 'confirmed'))`,
        [this.connector, cutoff],
      );
      const [runCountRows] = await connection.query<Row[]>(
        "SELECT COUNT(*) AS count FROM runs WHERE connector_id = ?",
        [this.connector],
      );
      const excess =
        number(runCountRows[0] ?? { count: 0 }, "count") - MAX_RETAINED_RUNS;
      if (excess > 0)
        await connection.query(
          `DELETE FROM runs WHERE connector_id = ? AND id IN (
            SELECT id FROM (
              SELECT runs.id FROM runs
              WHERE runs.connector_id = ? AND runs.state IN
                ('succeeded', 'completed_with_errors', 'degraded', 'canceled', 'failed', 'abandoned')
              AND NOT EXISTS (SELECT 1 FROM active_run WHERE active_run.connector_id = runs.connector_id AND active_run.run_id = runs.id)
              AND NOT EXISTS (SELECT 1 FROM manifest WHERE manifest.connector_id = runs.connector_id AND manifest.last_seen_run_id = runs.id)
              AND NOT EXISTS (SELECT 1 FROM deletion_plans WHERE deletion_plans.connector_id = runs.connector_id
                              AND deletion_plans.run_id = runs.id AND deletion_plans.state IN ('pending', 'confirmed'))
              ORDER BY runs.finished_at, runs.id LIMIT ?
            ) AS eligible
          )`,
          [this.connector, this.connector, excess],
        );
      const after = await this.retentionCounts(connection);
      return {
        runsDeleted: before.runs - after.runs,
        telemetryDeleted: before.telemetry - after.telemetry,
        issuesDeleted: before.issues - after.issues,
      };
    });
  }

  private async retentionCounts(connection: MysqlConnection) {
    const count = async (table: "runs" | "telemetry" | "issues") => {
      const [rows] = await connection.query<Row[]>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE connector_id = ?`,
        [this.connector],
      );
      return number(rows[0] ?? { count: 0 }, "count");
    };
    return {
      runs: await count("runs"),
      telemetry: await count("telemetry"),
      issues: await count("issues"),
    };
  }
}
