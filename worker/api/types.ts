import type { Brand, LocaleAvailability } from "../contracts/zendesk.ts";
import type { RunCounts, RunState } from "../reconciliation/model.ts";
import type { ExistingIndexDryRunResult } from "../reconciliation/existing-index-dry-run.ts";
import type { ExistingIndexApplyResult } from "../reconciliation/existing-index-apply.ts";

export interface SafeSetup {
  configured: boolean;
  state:
    | "destination_validated"
    | "unconfigured"
    | "ready"
    | "locked_after_first_success"
    | "attention_required";
  revision?: number;
  brand?: Brand;
  locales?: readonly string[];
  destinationName?: string;
  previewUrl?: string;
  oauthAvailable?: boolean;
  zendeskAuth?: "legacy" | "oauth" | "reconnect_required";
  zendeskAccount?: string;
  zendeskConfigured: boolean;
  searchstaxConfigured: boolean;
}

export interface SafeRun {
  id: string;
  workflowId: string;
  state: RunState;
  counts: RunCounts;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  failureCode?: string;
  deletionPlan?: {
    id: string;
    staleCount: number;
    exactIds: readonly string[];
    fingerprint: string;
  };
}

export interface SafeScheduler {
  state: "disabled" | "enabled" | "paused";
  retryAttempt: number;
  nextRunAt?: string;
  pauseReason?:
    "operator" | "guarded_action" | "permanent_failure" | "retries_exhausted";
}

export interface SafeIssue {
  articleId: string;
  locale: string;
  publicTitle: string;
  publicUrl: string;
  reasonCode: string;
}

export interface SafeIncident {
  key: string;
  phase: string;
  event: string;
  createdAt: string;
  attempt?: number;
}

export interface Dashboard {
  setup: SafeSetup;
  manifestCounts: readonly { locale: string; count: number }[];
  activeRun: SafeRun | null;
  scheduler: SafeScheduler;
  issues: readonly SafeIssue[];
  incidents: readonly SafeIncident[];
}

export interface ZendeskValidation {
  brands: readonly Brand[];
  locales: readonly LocaleAvailability[];
}

export interface LocalePlan {
  id: string;
  locales: readonly string[];
  removedRecordCount: number;
  fingerprint: string;
}

export interface NamespaceRecoveryPlan {
  recordCount: number;
  fingerprint: string;
}

export type SafeReadinessPhase =
  | "checking_namespace"
  | "recovering_cleanup"
  | "writing"
  | "waiting_for_visibility"
  | "deleting"
  | "confirming_cleanup";

export interface SafeReadinessStatus {
  phase: SafeReadinessPhase;
  startedAt: string;
  deadlineAt: string;
}

export interface WebhookStatus {
  enabled: boolean;
  endpoint: "/api/webhooks/zendesk";
  requiresHttps: true;
  signingSecretConfigured: boolean;
}

export interface WebhookResult {
  accepted: boolean;
  ignored?: "unsupported_event" | "brand_or_locale_not_selected";
  runId?: string;
}

export interface SetupInput {
  accountSubdomain: string;
  email: string;
  apiToken: string;
  oauthHandle?: string;
  _oauthSession?: string;
  brandId: string;
  locales: string[];
  connectorKey: string;
  updateEndpoint: string;
  selectEndpoint: string;
  token: string;
  destinationName: string;
  previewUrl?: string;
}

export interface ApplicationService {
  oauthCancel?(session: string): Promise<void>;
  oauthStart?(
    input: Record<string, unknown>,
    session: string,
  ): Promise<{ authorizationUrl: string; handle: string }>;
  oauthCallback?(state: string, code: string, session: string): Promise<void>;
  oauthCandidate?(
    session: string,
  ): Promise<{ handle: string; accountSubdomain: string } | null>;
  setup(): Promise<SafeSetup>;
  validateZendesk(input: Record<string, unknown>): Promise<ZendeskValidation>;
  checkSearchStaxConnection(input: Record<string, unknown>): Promise<void>;
  retrySetup(input: Record<string, unknown>): Promise<SafeSetup>;
  validateSearchStax(input: Record<string, unknown>): Promise<void>;
  readinessStatus(): Promise<SafeReadinessStatus | null>;
  completeSetup(input: SetupInput): Promise<SafeSetup>;
  planRecovery(input: SetupInput): Promise<NamespaceRecoveryPlan>;
  applyRecovery(input: SetupInput, fingerprint: string): Promise<SafeSetup>;
  replaceZendesk(input: Record<string, unknown>): Promise<SafeSetup>;
  replaceSearchStax(input: Record<string, unknown>): Promise<SafeSetup>;
  dashboard(): Promise<Dashboard>;
  setScheduler(enabled: boolean): Promise<SafeScheduler>;
  runs(cursor?: string): Promise<{ runs: SafeRun[]; nextCursor?: string }>;
  startRun(): Promise<{ runId: string }>;
  existingIndexDryRun(): Promise<ExistingIndexDryRunResult>;
  existingIndexApply(
    fingerprint: string,
    legacyIngestionPaused: boolean,
  ): Promise<ExistingIndexApplyResult>;
  cancelRun(runId: string): Promise<void>;
  planLocales(locales: string[]): Promise<LocalePlan>;
  applyLocales(planId: string, fingerprint: string): Promise<SafeSetup>;
  deletionPlan(planId: string): Promise<{
    id: string;
    runId: string;
    staleCount: number;
    exactIds: readonly string[];
    state: string;
    fingerprint: string;
  }>;
  confirmDeletion(planId: string, fingerprint: string): Promise<void>;
  webhookStatus?(): WebhookStatus;
  receiveZendeskWebhook?(
    rawBody: string,
    signature: string | null,
    timestamp: string | null,
    secure: boolean,
  ): Promise<WebhookResult>;
}
