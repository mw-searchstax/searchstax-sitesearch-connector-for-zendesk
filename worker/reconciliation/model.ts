import { normalizeLocale, type PreparedRecord } from "../contracts/record.ts";
import { ContractError } from "../contracts/shared.ts";

export interface ZendeskSourceIdentity {
  subdomain: string;
  articleId: string;
  locale: string;
}

export function canonicalZendeskSourceIdentity(
  subdomain: string,
  articleId: string,
  locale: string,
): ZendeskSourceIdentity {
  const normalizedSubdomain = subdomain.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(normalizedSubdomain))
    throw new ContractError(
      "INVALID_CONFIGURATION",
      "Zendesk subdomain was invalid.",
    );
  if (!/^\d+$/u.test(articleId))
    throw new ContractError(
      "INVALID_RECORD",
      "Zendesk article ID must be an absolute decimal string.",
    );
  return {
    subdomain: normalizedSubdomain,
    articleId,
    locale: normalizeLocale(locale),
  };
}

export function sourceIdentityKey(identity: ZendeskSourceIdentity): string {
  return JSON.stringify([
    identity.subdomain,
    identity.articleId,
    identity.locale,
  ]);
}

export type RunState =
  | "queued"
  | "enumerating"
  | "planning"
  | "writing"
  | "reconciling"
  | "guarded"
  | "deleting"
  | "cancel_requested"
  | "action_required"
  | "succeeded"
  | "completed_with_errors"
  | "degraded"
  | "canceled"
  | "failed"
  | "abandoned";

export interface ReconciliationConfig {
  revision: number;
  connectorKey: string;
  zendeskSubdomain: string;
  locales: readonly string[];
  target: "local" | "hosted";
}

export interface StagedRecord extends PreparedRecord {
  destinationId: string;
  sourceIdentity: ZendeskSourceIdentity;
  articleId: string;
  translationId: string;
  locale: string;
  sourceUpdatedAt: string;
}

export interface ManifestRecord {
  destinationId: string;
  sourceIdentity: ZendeskSourceIdentity;
  translationId: string;
  sourceUpdatedAt: string;
  hash: string;
  lastSeenRunId: string;
  acknowledgedAt: string;
}

export interface QuarantinedRecord {
  id: string;
  articleId: string;
  locale: string;
  publicTitle: string;
  publicUrl: string;
  reasonCode: string;
}

export interface IssueRecord extends QuarantinedRecord {
  state: "active" | "resolved";
  firstSeenRunId: string;
  lastSeenRunId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
}

export interface RunCounts {
  source: number;
  created: number;
  changed: number;
  unchanged: number;
  stale: number;
  plannedDeletions: number;
  successfulDeletions: number;
  failedDeletions: number;
  withheldDeletions: number;
  warnings: number;
  quarantined: number;
}

export interface RunRecord {
  id: string;
  workflowId: string;
  configRevision: number;
  state: RunState;
  counts: RunCounts;
  failureCode?: string;
}

export interface TelemetryRecord {
  runId: string;
  phase: string;
  event: string;
  visibility: "operator" | "diagnostic";
  attempt?: number;
  batchNumber?: number;
  recordCount?: number;
  durationMs?: number;
  createdAt: string;
}

export interface DeletionPlan {
  id: string;
  runId: string;
  exactIds: readonly string[];
  configRevision: number;
  manifestRevision: number;
  manifestFingerprint: string;
  sourceFingerprint: string;
  destinationFingerprint: string;
  fingerprint: string;
  state: "pending" | "confirmed" | "invalidated" | "applied";
}

export interface ReconciliationStore {
  configurationRevision(): Promise<number>;
  activeRun(): Promise<RunRecord | null>;
  admitRun(run: RunRecord): Promise<boolean>;
  abandonRun(runId: string, failureCode?: string): Promise<void>;
  updateRun(
    runId: string,
    state: RunState,
    counts?: RunCounts,
    failureCode?: string,
  ): Promise<void>;
  run(runId: string): Promise<RunRecord | null>;
  requestCancellation(runId: string): Promise<boolean>;
  clearStaging(runId: string): Promise<void>;
  stage(runId: string, records: readonly StagedRecord[]): Promise<void>;
  staged(runId: string): Promise<StagedRecord[]>;
  manifest(): Promise<ManifestRecord[]>;
  manifestRevision(): Promise<number>;
  acknowledge(
    runId: string,
    records: readonly StagedRecord[],
    acknowledgedAt: string,
  ): Promise<void>;
  markUnchanged(runId: string, ids: readonly string[]): Promise<void>;
  removeManifest(ids: readonly string[]): Promise<void>;
  syncIssues(
    runId: string,
    locales: readonly string[],
    records: readonly QuarantinedRecord[],
    observedAt: string,
  ): Promise<void>;
  quarantined(runId: string): Promise<QuarantinedRecord[]>;
  appendTelemetry(event: TelemetryRecord): Promise<void>;
  saveDeletionPlan(plan: DeletionPlan): Promise<void>;
  deletionPlan(planId: string): Promise<DeletionPlan | null>;
  updateDeletionPlan(
    planId: string,
    state: DeletionPlan["state"],
  ): Promise<void>;
  finish(
    runId: string,
    state:
      | "succeeded"
      | "completed_with_errors"
      | "degraded"
      | "canceled"
      | "failed",
  ): Promise<void>;
}

export function emptyCounts(): RunCounts {
  return {
    source: 0,
    created: 0,
    changed: 0,
    unchanged: 0,
    stale: 0,
    plannedDeletions: 0,
    successfulDeletions: 0,
    failedDeletions: 0,
    withheldDeletions: 0,
    warnings: 0,
    quarantined: 0,
  };
}
