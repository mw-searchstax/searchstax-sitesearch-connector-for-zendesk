import type {
  DeletionPlan,
  ManifestRecord,
  IssueRecord,
  QuarantinedRecord,
  ReconciliationStore,
  RunCounts,
  RunRecord,
  RunState,
  StagedRecord,
  TelemetryRecord,
} from "./model.ts";
import { sourceIdentityKey } from "./model.ts";

function copyRun(run: RunRecord): RunRecord {
  return { ...run, counts: { ...run.counts } };
}

export class MemoryReconciliationStore implements ReconciliationStore {
  configRevision: number;
  readonly runs = new Map<string, RunRecord>();
  readonly staging = new Map<string, Map<string, StagedRecord>>();
  readonly manifestRecords = new Map<string, ManifestRecord>();
  readonly plans = new Map<string, DeletionPlan>();
  readonly issueRecords: IssueRecord[] = [];
  readonly telemetryEvents: TelemetryRecord[] = [];
  activeRunId: string | null = null;
  revision = 0;

  constructor(configRevision = 1) {
    this.configRevision = configRevision;
  }

  async configurationRevision() {
    return this.configRevision;
  }

  async activeRun() {
    const run = this.activeRunId ? this.runs.get(this.activeRunId) : undefined;
    return run ? copyRun(run) : null;
  }

  async admitRun(run: RunRecord) {
    if (this.activeRunId !== null) return false;
    this.runs.set(run.id, copyRun(run));
    this.activeRunId = run.id;
    return true;
  }

  async abandonRun(runId: string, failureCode = "ABANDONED_WORKFLOW") {
    const run = this.runs.get(runId);
    if (run) {
      run.state = "abandoned";
      run.failureCode = failureCode;
    }
    this.staging.delete(runId);
    if (this.activeRunId === runId) this.activeRunId = null;
  }

  async updateRun(
    runId: string,
    state: RunState,
    counts?: RunCounts,
    failureCode?: string,
  ) {
    const run = this.runs.get(runId);
    if (!run) throw new Error("Run was missing.");
    run.state = state;
    if (counts) run.counts = { ...counts };
    if (failureCode) run.failureCode = failureCode;
  }

  async run(runId: string) {
    const run = this.runs.get(runId);
    return run ? copyRun(run) : null;
  }

  async requestCancellation(runId: string) {
    const run = this.runs.get(runId);
    if (!run || this.activeRunId !== runId) return false;
    run.state = "cancel_requested";
    return true;
  }

  async clearStaging(runId: string) {
    this.staging.delete(runId);
  }

  async stage(runId: string, records: readonly StagedRecord[]) {
    const staged = this.staging.get(runId) ?? new Map<string, StagedRecord>();
    for (const record of records) {
      if (staged.has(record.destinationId))
        throw new Error("Duplicate staged record.");
      staged.set(record.destinationId, structuredClone(record));
    }
    this.staging.set(runId, staged);
  }

  async staged(runId: string) {
    return [...(this.staging.get(runId)?.values() ?? [])].map((record) =>
      structuredClone(record),
    );
  }

  async manifest() {
    return [...this.manifestRecords.values()].map((record) => ({ ...record }));
  }

  async manifestRevision() {
    return this.revision;
  }

  async acknowledge(
    runId: string,
    records: readonly StagedRecord[],
    acknowledgedAt: string,
  ) {
    for (const record of records) {
      const sourceKey = sourceIdentityKey(record.sourceIdentity);
      for (const [destinationId, existing] of this.manifestRecords) {
        if (
          sourceIdentityKey(existing.sourceIdentity) === sourceKey &&
          destinationId !== record.destinationId
        )
          this.manifestRecords.delete(destinationId);
      }
      this.manifestRecords.set(record.destinationId, {
        destinationId: record.destinationId,
        sourceIdentity: structuredClone(record.sourceIdentity),
        translationId: record.translationId,
        sourceUpdatedAt: record.sourceUpdatedAt,
        hash: record.hash,
        lastSeenRunId: runId,
        acknowledgedAt,
      });
    }
    if (records.length) this.revision += 1;
  }

  async markUnchanged(runId: string, ids: readonly string[]) {
    for (const id of ids) {
      const record = this.manifestRecords.get(id);
      if (!record) throw new Error("Manifest record was missing.");
      record.lastSeenRunId = runId;
    }
    if (ids.length) this.revision += 1;
  }

  async removeManifest(ids: readonly string[]) {
    for (const id of ids) this.manifestRecords.delete(id);
    if (ids.length) this.revision += 1;
  }

  async syncIssues(
    runId: string,
    locales: readonly string[],
    records: readonly QuarantinedRecord[],
    observedAt: string,
  ) {
    const current = new Set(
      records.map(({ articleId, locale, reasonCode }) =>
        JSON.stringify([articleId, locale, reasonCode]),
      ),
    );
    for (const issue of this.issueRecords) {
      const key = JSON.stringify([
        issue.articleId,
        issue.locale,
        issue.reasonCode,
      ]);
      if (
        issue.state === "active" &&
        locales.includes(issue.locale) &&
        !current.has(key)
      ) {
        issue.state = "resolved";
        issue.resolvedAt = observedAt;
      }
    }
    for (const record of records) {
      const existing = this.issueRecords.find(
        (issue) =>
          issue.articleId === record.articleId &&
          issue.locale === record.locale &&
          issue.reasonCode === record.reasonCode,
      );
      if (existing) {
        Object.assign(existing, record, {
          state: "active",
          lastSeenRunId: runId,
          lastSeenAt: observedAt,
          resolvedAt: undefined,
        });
      } else {
        this.issueRecords.push({
          ...record,
          state: "active",
          firstSeenRunId: runId,
          lastSeenRunId: runId,
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
        });
      }
    }
  }

  async quarantined(runId: string) {
    return this.issueRecords
      .filter((issue) => issue.lastSeenRunId === runId)
      .map(({ id, articleId, locale, publicTitle, publicUrl, reasonCode }) => ({
        id,
        articleId,
        locale,
        publicTitle,
        publicUrl,
        reasonCode,
      }));
  }

  async appendTelemetry(event: TelemetryRecord) {
    this.telemetryEvents.push({ ...event });
  }

  async saveDeletionPlan(plan: DeletionPlan) {
    this.plans.set(plan.id, structuredClone(plan));
  }

  async deletionPlan(planId: string) {
    const plan = this.plans.get(planId);
    return plan ? structuredClone(plan) : null;
  }

  async updateDeletionPlan(planId: string, state: DeletionPlan["state"]) {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error("Deletion plan was missing.");
    plan.state = state;
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
    const run = this.runs.get(runId);
    if (run) run.state = state;
    this.staging.delete(runId);
    if (this.activeRunId === runId) this.activeRunId = null;
  }
}
