import type {
  ReconciliationStore,
  RunRecord,
  StagedRecord,
  TelemetryRecord,
} from "../worker/reconciliation/model.ts";

export interface StoredConfiguration {
  revision: number;
  state:
    | "unconfigured"
    | "source_validated"
    | "destination_validated"
    | "ready"
    | "locked_after_first_success"
    | "attention_required";
  connectorKey: string;
  brandId: string;
  brandName: string;
  brandSubdomain: string;
  selectedLocales: readonly string[];
  destinationName: string;
  previewUrl?: string;
  target: "local" | "hosted";
  credentialEnvelope: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredLocalePlan {
  id: string;
  configRevision: number;
  selectedLocales: readonly string[];
  removedRecordCount: number;
  fingerprint: string;
  state: "pending" | "applied" | "invalidated";
  createdAt: string;
}

export interface StoredIssue {
  id: string;
  articleId: string;
  locale: string;
  publicTitle: string;
  publicUrl: string;
  reasonCode: string;
  state: "active" | "resolved";
  firstSeenRunId: string;
  lastSeenRunId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
}

export type StoredTelemetry = TelemetryRecord;

export interface StoredScheduler {
  state: "disabled" | "enabled" | "paused";
  nextRunAt?: string;
  retryAttempt: 0 | 1 | 2;
  pauseReason?:
    "operator" | "guarded_action" | "permanent_failure" | "retries_exhausted";
  updatedAt: string;
}

export interface StoredRun extends RunRecord {
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  deletionPlan?: {
    id: string;
    staleCount: number;
    exactIds: readonly string[];
    fingerprint: string;
  };
}

export interface ApplicationStateStore extends ReconciliationStore {
  saveConfiguration(configuration: StoredConfiguration): Promise<void>;
  compareAndSwapCredentials(
    expectedRevision: number,
    expectedEnvelope: string,
    newEnvelope: string,
  ): Promise<boolean>;
  configuration(): Promise<StoredConfiguration | null>;
  recoveryAvailable(): Promise<boolean>;
  adoptNamespace(
    configuration: StoredConfiguration,
    records: readonly StagedRecord[],
    runId: string,
    observedAt: string,
  ): Promise<void>;
  scheduler(): Promise<StoredScheduler>;
  saveScheduler(
    scheduler: Omit<StoredScheduler, "updatedAt">,
  ): Promise<StoredScheduler>;
  pendingProbe(): Promise<string | null>;
  savePendingProbe(id: string): Promise<void>;
  clearPendingProbe(id: string): Promise<void>;
  runDetails(runId: string): Promise<StoredRun | null>;
  activeRunDetails(): Promise<StoredRun | null>;
  runHistory(before?: { startedAt: string; id: string }): Promise<StoredRun[]>;
  saveLocalePlan(plan: StoredLocalePlan): Promise<void>;
  localePlan(planId: string): Promise<StoredLocalePlan | null>;
  applyLocalePlan(
    planId: string,
    fingerprint: string,
  ): Promise<"applied" | "stale">;
  saveIssue(issue: StoredIssue): Promise<void>;
  issues(): Promise<StoredIssue[]>;
  incidents(): Promise<StoredTelemetry[]>;
  pruneHistory(): Promise<{
    runsDeleted: number;
    telemetryDeleted: number;
    issuesDeleted: number;
  }>;
}
