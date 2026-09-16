import { CredentialCoordinator } from "./zendesk-auth-state.ts";
import {
  OAuthTransport,
  OAuthAttempts,
  type OAuthSettings,
  type OAuthTokens,
} from "./zendesk-oauth.ts";
import { randomUUID } from "node:crypto";

import {
  assertConnectorKeyAvailable,
  createUpsertBatches,
  discoverBrands,
  discoverLocales,
  readinessProbe,
  type PendingProbeStore,
} from "../worker/contracts/index.ts";
import {
  normalizeSearchStaxSettings,
  type SearchStaxSettings,
} from "../worker/contracts/searchstax.ts";
import { normalizeLocale } from "../worker/contracts/record.ts";
import { ContractError } from "../worker/contracts/shared.ts";
import type {
  ZendeskClient,
  ZendeskCredentials,
} from "../worker/contracts/zendesk.ts";
import { ApiError } from "../worker/api/router.ts";
import type {
  ApplicationService,
  Dashboard,
  SafeRun,
  SafeScheduler,
  SafeIssue,
  SafeIncident,
  SafeReadinessStatus,
  SafeSetup,
  SetupInput,
  NamespaceRecoveryPlan,
  WebhookResult,
  WebhookStatus,
} from "../worker/api/types.ts";
import {
  reconciliationDependencies,
  type RuntimeConfiguration,
} from "../worker/reconciliation/dependencies.ts";
import {
  admitReconciliation,
  confirmDeletion,
  reconcileArticle,
  reconcile,
  type ReconciliationDependencies,
  type ReconciliationResult,
} from "../worker/reconciliation/engine.ts";
import { existingIndexDryRun } from "../worker/reconciliation/existing-index-dry-run.ts";
import {
  existingIndexApply,
  type ExistingIndexApplyDependencies,
} from "../worker/reconciliation/existing-index-apply.ts";
import {
  decryptConfiguration,
  encryptConfiguration,
  type EncryptedEnvelope,
} from "../worker/reconciliation/crypto.ts";
import {
  emptyCounts,
  type QuarantinedRecord,
  type StagedRecord,
} from "../worker/reconciliation/model.ts";
import { startLoopbackHost, type HttpHostOptions } from "./http-host.ts";
import {
  configuredZendeskLocale,
  parseZendeskArticleWebhook,
  verifyZendeskWebhookSignature,
} from "./zendesk-webhook.ts";
import {
  type ApplicationStateStore,
  type StoredConfiguration,
  type StoredIssue,
  type StoredRun,
  type StoredScheduler,
  type StoredTelemetry,
} from "./application-state.ts";

export type DependencyFactory = (
  runtime: RuntimeConfiguration,
) => ReconciliationDependencies;

export interface ApplicationVendors {
  discoverBrands: typeof discoverBrands;
  discoverLocales: typeof discoverLocales;
  assertConnectorKeyAvailable: typeof assertConnectorKeyAvailable;
  readinessProbe: typeof readinessProbe;
}

const applicationVendors: ApplicationVendors = {
  discoverBrands,
  discoverLocales,
  assertConnectorKeyAvailable,
  readinessProbe,
};

const READINESS_VISIBILITY_DEADLINE_MS = 10 * 60 * 1_000 + 10_000;
const READINESS_TOTAL_DEADLINE_MS = 20 * 60 * 1_000 + 20_000;

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim())
    throw new ApiError(400, "INVALID_INPUT", `${key} was required.`);
  return value.trim();
}

function credentials(input: Record<string, unknown>): ZendeskCredentials {
  return {
    accountSubdomain: text(input, "accountSubdomain"),
    email: text(input, "email"),
    apiToken: text(input, "apiToken"),
  };
}

function destination(input: Record<string, unknown>): SearchStaxSettings {
  return normalizeSearchStaxSettings({
    updateEndpoint: text(input, "updateEndpoint"),
    selectEndpoint: text(input, "selectEndpoint"),
    token: text(input, "token"),
  });
}

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function pendingProbeStore(store: ApplicationStateStore): PendingProbeStore {
  return {
    get: () => store.pendingProbe(),
    set: (id) => store.savePendingProbe(id),
    clear: (id) => store.clearPendingProbe(id),
  };
}

function safeSetup(configuration: StoredConfiguration | null): SafeSetup {
  if (!configuration)
    return {
      configured: false,
      state: "unconfigured",
      zendeskConfigured: false,
      searchstaxConfigured: false,
    };
  return {
    configured: true,
    state: configuration.state as SafeSetup["state"],
    revision: configuration.revision,
    brand: {
      id: configuration.brandId,
      name: configuration.brandName,
      subdomain: configuration.brandSubdomain,
    },
    locales: configuration.selectedLocales,
    destinationName: configuration.destinationName,
    ...(configuration.previewUrl
      ? { previewUrl: configuration.previewUrl }
      : {}),
    zendeskConfigured: true,
    searchstaxConfigured: true,
  };
}

function safeRun(run: StoredRun): SafeRun {
  return {
    id: run.id,
    workflowId: run.workflowId,
    state: run.state,
    counts: run.counts,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.failureCode ? { failureCode: run.failureCode } : {}),
    ...(run.deletionPlan ? { deletionPlan: run.deletionPlan } : {}),
  };
}

function safeScheduler(scheduler: StoredScheduler): SafeScheduler {
  return {
    state: scheduler.state,
    retryAttempt: scheduler.retryAttempt,
    ...(scheduler.nextRunAt ? { nextRunAt: scheduler.nextRunAt } : {}),
    ...(scheduler.pauseReason ? { pauseReason: scheduler.pauseReason } : {}),
  };
}

function safeIssue(issue: StoredIssue): SafeIssue {
  return {
    articleId: issue.articleId,
    locale: issue.locale,
    publicTitle: issue.publicTitle,
    publicUrl: issue.publicUrl,
    reasonCode: issue.reasonCode,
  };
}

function safeIncident(event: StoredTelemetry): SafeIncident {
  return {
    key: `${event.runId}:${event.event}:${event.createdAt}`,
    phase: event.phase,
    event: event.event,
    createdAt: event.createdAt,
    ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
  };
}

async function runtimeConfiguration(
  store: ApplicationStateStore,
  encryptionKey: string,
): Promise<RuntimeConfiguration> {
  const configuration = await store.configuration();
  if (
    !configuration ||
    !["ready", "locked_after_first_success"].includes(configuration.state)
  )
    throw new ApiError(409, "SETUP_REQUIRED", "Complete setup first.");
  return {
    reconciliation: {
      revision: configuration.revision,
      connectorKey: configuration.connectorKey,
      zendeskSubdomain: configuration.brandSubdomain,
      locales: configuration.selectedLocales,
      target: configuration.target,
    },
    brand: {
      id: configuration.brandId,
      name: configuration.brandName,
      subdomain: configuration.brandSubdomain,
    },
    secrets: await decryptConfiguration(
      JSON.parse(configuration.credentialEnvelope) as EncryptedEnvelope,
      encryptionKey,
    ),
  };
}

type RunOrigin = "manual" | "automatic" | "webhook";
type CompletionHandler = (
  origin: RunOrigin,
  result: ReconciliationResult,
) => Promise<void>;

class LocalRunLifecycle {
  private readonly tasks = new Map<string, Promise<void>>();
  private completion?: CompletionHandler;

  constructor(
    private readonly store: ApplicationStateStore,
    private readonly loadRuntime: () => Promise<RuntimeConfiguration>,
    private readonly dependencies: DependencyFactory,
    private readonly credentialGate?: CredentialCoordinator,
  ) {}

  onCompletion(handler: CompletionHandler) {
    this.completion = handler;
  }

  async recover() {
    const active = await this.store.activeRun();
    if (
      active &&
      active.state !== "guarded" &&
      active.state !== "action_required"
    ) {
      await this.store.abandonRun(active.id, "LOCAL_PROCESS_INTERRUPTED");
      await this.store.appendTelemetry({
        runId: active.id,
        phase: "abandoned",
        event: "run_abandoned",
        visibility: "operator",
        createdAt: new Date().toISOString(),
      });
    }
  }

  async start(
    origin: RunOrigin = "manual",
    afterAdmission?: (runId: string) => Promise<void>,
    operation: (
      runtime: RuntimeConfiguration,
      runId: string,
    ) => Promise<ReconciliationResult> = (runtime, runId) =>
      reconcile(
        this.store,
        runtime.reconciliation,
        runId,
        this.dependencies(runtime),
      ),
  ) {
    return this.credentialGate
      ? this.credentialGate.exclusive(() =>
          this.startExclusive(origin, afterAdmission, operation),
        )
      : this.startExclusive(origin, afterAdmission, operation);
  }
  private async startExclusive(
    origin: RunOrigin = "manual",
    afterAdmission?: (runId: string) => Promise<void>,
    operation: (
      runtime: RuntimeConfiguration,
      runId: string,
    ) => Promise<ReconciliationResult> = (runtime, runId) =>
      reconcile(
        this.store,
        runtime.reconciliation,
        runId,
        this.dependencies(runtime),
      ),
  ) {
    const runtime = await this.loadRuntime();
    const runId = randomUUID();
    const admitted = await admitReconciliation(
      this.store,
      runtime.reconciliation,
      runId,
      `local-${runId}`,
      async () => false,
    );
    if (!admitted)
      throw new ApiError(
        409,
        "RUN_ACTIVE",
        "A reconciliation is already active.",
      );
    try {
      await afterAdmission?.(runId);
    } catch (error) {
      await this.store.abandonRun(runId, "LOCAL_SCHEDULER_FAILED");
      throw error;
    }
    this.track(runId, origin, () => operation(runtime, runId));
    return { runId };
  }

  async cancel(runId: string) {
    const run = await this.store.run(runId);
    if (!run || !(await this.store.requestCancellation(runId)))
      throw new ApiError(
        409,
        "CANCEL_UNAVAILABLE",
        "The run can no longer be canceled.",
      );
    if (
      ["guarded", "action_required"].includes(run.state) &&
      !this.tasks.has(runId)
    ) {
      await this.store.appendTelemetry({
        runId,
        phase: "canceled",
        event: "run_canceled",
        visibility: "operator",
        createdAt: new Date().toISOString(),
      });
      await this.store.finish(runId, "canceled").then(() =>
        this.completion?.("manual", {
          runId,
          state: "canceled",
          counts: run.counts,
        }),
      );
    }
  }

  async confirm(planId: string, fingerprint: string) {
    const runtime = await this.loadRuntime();
    const plan = await this.store.deletionPlan(planId);
    const run = plan ? await this.store.run(plan.runId) : null;
    if (
      !plan ||
      !run ||
      plan.state !== "pending" ||
      plan.fingerprint !== fingerprint ||
      !["guarded", "action_required"].includes(run.state)
    )
      throw new ApiError(
        409,
        "STALE_DELETION_PLAN",
        "The deletion plan is stale or does not match.",
      );
    this.track(run.id, "manual", () =>
      confirmDeletion(
        this.store,
        runtime.reconciliation,
        planId,
        fingerprint,
        this.dependencies(runtime),
      ),
    );
  }

  async close() {
    for (const runId of this.tasks.keys())
      await this.store.requestCancellation(runId);
    await Promise.all(this.tasks.values());
  }

  private track(
    runId: string,
    origin: RunOrigin,
    operation: () => Promise<ReconciliationResult>,
  ) {
    const task = operation()
      .catch(async (): Promise<ReconciliationResult> => {
        const run = await this.store.run(runId);
        if (
          run &&
          ![
            "succeeded",
            "degraded",
            "canceled",
            "failed",
            "abandoned",
            "action_required",
          ].includes(run.state)
        ) {
          await this.store.updateRun(
            runId,
            "failed",
            undefined,
            "LOCAL_RUN_FAILED",
          );
          await this.store.finish(runId, "failed");
        }
        return {
          runId,
          state: "failed",
          counts: run?.counts ?? emptyCounts(),
        };
      })
      .then(async (result) => {
        await this.completion?.(origin, result);
        if (!["guarded", "action_required"].includes(result.state))
          await this.store.pruneHistory();
      })
      .finally(() => {
        this.tasks.delete(runId);
      });
    this.tasks.set(runId, task);
  }
}

const HOUR_MS = 60 * 60 * 1_000;
const RETRY_DELAYS_MS = [5 * 60 * 1_000, 15 * 60 * 1_000] as const;

export interface SchedulerTiming {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultSchedulerTiming: SchedulerTiming = {
  now: Date.now,
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function transientFailure(code: string | undefined): boolean {
  if (!code) return false;
  return (
    /(?:^|_)(?:TRANSIENT_HTTP_FAILURE|REQUEST_FAILED|REQUEST_TIMEOUT|FETCH_REJECTED)$/u.test(
      code,
    ) ||
    /(?:^|_)REQUEST_REJECTED_[TFLEV]{3}$/u.test(code) ||
    /(?:^|_)REQUEST_ATTEMPTS_[RTFLEV]{3}$/u.test(code) ||
    code === "VISIBILITY_TIMEOUT" ||
    code === "DESTINATION_PARITY_MISMATCH" ||
    code === "DESTINATION_FIELD_MISMATCH"
  );
}

class LocalScheduler {
  private timer?: unknown;
  private closing = false;
  private transition = Promise.resolve();

  constructor(
    private readonly store: ApplicationStateStore,
    private readonly lifecycle: LocalRunLifecycle,
    private readonly timing: SchedulerTiming,
  ) {
    lifecycle.onCompletion((origin, result) =>
      this.enqueue(() => this.handleCompletion(origin, result)),
    );
  }

  async start() {
    await this.enqueue(() => this.continueSchedule());
  }

  async status() {
    return safeScheduler(await this.store.scheduler());
  }

  async setEnabled(enabled: boolean) {
    return this.enqueue(async () => {
      if (this.closing)
        throw new ApiError(409, "SCHEDULER_CLOSING", "Scheduling is closing.");
      this.clearTimer();
      if (!enabled) {
        await this.store.saveScheduler({
          state: "paused",
          retryAttempt: 0,
          pauseReason: "operator",
        });
        return this.status();
      }
      await this.store.saveScheduler({
        state: "enabled",
        nextRunAt: this.isoNow(),
        retryAttempt: 0,
      });
      await this.tick();
      return this.status();
    });
  }

  async close() {
    this.closing = true;
    this.clearTimer();
    await this.transition;
  }

  private isoNow(offset = 0) {
    return new Date(this.timing.now() + offset).toISOString();
  }

  private clearTimer() {
    if (this.timer === undefined) return;
    this.timing.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(nextRunAt: string) {
    if (this.closing) return;
    this.clearTimer();
    const delay = Math.max(0, Date.parse(nextRunAt) - this.timing.now());
    this.timer = this.timing.setTimeout(() => {
      this.timer = undefined;
      void this.enqueue(async () => {
        try {
          await this.tick();
        } catch {
          await this.pause("permanent_failure");
        }
      });
    }, delay);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation, operation);
    this.transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async pause(reason: StoredScheduler["pauseReason"], runId?: string) {
    if (this.closing) return;
    this.clearTimer();
    const current = await this.store.scheduler();
    if (
      current.state === "disabled" ||
      (current.state === "paused" && current.pauseReason === "operator")
    )
      return;
    if (this.closing) return;
    await this.store.saveScheduler({
      state: "paused",
      retryAttempt: current.retryAttempt,
      ...(reason ? { pauseReason: reason } : {}),
    });
    if (runId)
      await this.store.appendTelemetry({
        runId,
        phase: "scheduler",
        event: "scheduler_paused",
        visibility: "operator",
        attempt: current.retryAttempt,
        createdAt: this.isoNow(),
      });
  }

  private async continueSchedule() {
    if (this.closing) return;
    const scheduler = await this.store.scheduler();
    if (this.closing) return;
    if (scheduler.state !== "enabled" || !scheduler.nextRunAt) {
      this.clearTimer();
      return;
    }
    const active = await this.store.activeRun();
    if (active && ["guarded", "action_required"].includes(active.state)) {
      await this.pause("guarded_action", active.id);
      return;
    }
    if (Date.parse(scheduler.nextRunAt) <= this.timing.now()) await this.tick();
    else this.arm(scheduler.nextRunAt);
  }

  private async tick() {
    if (this.closing) return;
    this.clearTimer();
    const scheduler = await this.store.scheduler();
    if (this.closing || scheduler.state !== "enabled" || !scheduler.nextRunAt)
      return;
    if (Date.parse(scheduler.nextRunAt) > this.timing.now()) {
      this.arm(scheduler.nextRunAt);
      return;
    }
    const active = await this.store.activeRun();
    if (this.closing) return;
    if (active) {
      if (["guarded", "action_required"].includes(active.state))
        await this.pause("guarded_action", active.id);
      return;
    }
    const startedAt = this.timing.now();
    try {
      await this.lifecycle.start("automatic", async () => {
        if (this.closing) throw new Error("Scheduler is closing.");
        await this.store.saveScheduler({
          state: "enabled",
          nextRunAt: new Date(startedAt + HOUR_MS).toISOString(),
          retryAttempt: scheduler.retryAttempt,
        });
      });
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "RUN_ACTIVE"))
        await this.pause("permanent_failure");
    }
    if (this.closing) return;
    const current = await this.store.scheduler();
    if (this.closing) return;
    if (current.state === "enabled" && current.nextRunAt)
      this.arm(current.nextRunAt);
  }

  private async handleCompletion(
    origin: RunOrigin,
    result: ReconciliationResult,
  ) {
    if (this.closing) return;
    let scheduler = await this.store.scheduler();
    if (this.closing) return;
    if (["guarded", "action_required"].includes(result.state)) {
      if (scheduler.state === "enabled")
        await this.pause("guarded_action", result.runId);
      return;
    }

    if (origin === "automatic" && scheduler.state === "enabled") {
      if (result.state === "failed") {
        const run = await this.store.run(result.runId);
        if (!transientFailure(run?.failureCode)) {
          await this.pause("permanent_failure", result.runId);
          return;
        }
        if (scheduler.retryAttempt === 2) {
          await this.pause("retries_exhausted", result.runId);
          return;
        }
        const retryAttempt = scheduler.retryAttempt === 0 ? 1 : 2;
        await this.store.saveScheduler({
          state: "enabled",
          nextRunAt: this.isoNow(RETRY_DELAYS_MS[scheduler.retryAttempt]),
          retryAttempt,
        });
        await this.store.appendTelemetry({
          runId: result.runId,
          phase: "scheduler",
          event: "retry_scheduled",
          visibility: "operator",
          attempt: retryAttempt,
          createdAt: this.isoNow(),
        });
        await this.continueSchedule();
        return;
      }
      if (
        ["succeeded", "completed_with_errors", "degraded"].includes(
          result.state,
        )
      ) {
        await this.store.saveScheduler({
          state: "enabled",
          nextRunAt:
            scheduler.nextRunAt &&
            Date.parse(scheduler.nextRunAt) > this.timing.now()
              ? scheduler.nextRunAt
              : this.isoNow(HOUR_MS),
          retryAttempt: 0,
        });
      }
      await this.continueSchedule();
      return;
    }

    scheduler = await this.store.scheduler();
    if (
      origin === "manual" &&
      ["succeeded", "completed_with_errors", "degraded"].includes(result.state)
    ) {
      if (
        scheduler.state === "paused" &&
        scheduler.pauseReason !== "operator"
      ) {
        await this.store.saveScheduler({
          state: "enabled",
          nextRunAt: this.isoNow(HOUR_MS),
          retryAttempt: 0,
        });
      } else if (
        scheduler.state === "enabled" &&
        scheduler.nextRunAt &&
        Date.parse(scheduler.nextRunAt) <= this.timing.now()
      ) {
        await this.store.saveScheduler({
          state: "enabled",
          nextRunAt: this.isoNow(HOUR_MS),
          retryAttempt: 0,
        });
      }
    }
    await this.continueSchedule();
  }
}

class NodeApplicationService implements ApplicationService {
  private readonly oauthCandidates = new Map<string, string>();
  private activeReadiness: SafeReadinessStatus | null = null;
  private setupTask: Promise<void> | null = null;
  private savingSetup = false;
  private closing = false;
  private readonly setupAbort = new AbortController();

  async resumeSetup() {
    const configuration = await this.store.configuration();
    if (configuration?.state === "destination_validated")
      this.startSetupReadiness();
  }

  async close() {
    this.closing = true;
    this.setupAbort.abort();
    await this.setupTask;
  }

  private startSetupReadiness() {
    if (this.setupTask || this.closing) return;
    this.setupTask = this.finishSetupReadiness()
      .catch(() => {
        // Keep durable pending state if persistence fails; startup retries it.
      })
      .finally(() => {
        this.setupTask = null;
      });
  }

  private async finishSetupReadiness() {
    const configuration = await this.store.configuration();
    if (!configuration || configuration.state !== "destination_validated")
      return;
    let state: StoredConfiguration["state"] = "ready";
    try {
      const secrets = await decryptConfiguration<
        RuntimeConfiguration["secrets"]
      >(
        JSON.parse(configuration.credentialEnvelope) as EncryptedEnvelope,
        this.encryptionKey,
      );
      await this.validateSearchStax(
        { ...secrets.searchstax, connectorKey: configuration.connectorKey },
        this.setupAbort.signal,
      );
    } catch {
      state = "attention_required";
    }
    if (this.closing) return;
    await this.credentialCoordinator.exclusive(async () => {
      const current = await this.store.configuration();
      if (
        current?.revision === configuration.revision &&
        current.state === "destination_validated"
      )
        await this.store.saveConfiguration({
          ...current,
          state,
          updatedAt: new Date().toISOString(),
        });
    });
  }

  async retrySetup(input: Record<string, unknown>) {
    return this.credentialCoordinator.exclusive(() =>
      this.retrySetupExclusive(input),
    );
  }

  private async retrySetupExclusive(input: Record<string, unknown>) {
    if (this.setupTask || this.savingSetup || this.closing)
      throw new ApiError(
        409,
        "READINESS_ACTIVE",
        "Index checks are already running. View setup progress.",
      );
    this.savingSetup = true;
    try {
      const configuration = await this.store.configuration();
      if (!configuration || configuration.state !== "attention_required")
        throw new ApiError(
          409,
          "SETUP_RETRY_UNAVAILABLE",
          "Setup does not need a retry. Refresh the dashboard.",
        );
      let envelope = configuration.credentialEnvelope;
      if (Object.keys(input).length) {
        const searchstax = destination(input);
        const secrets = await decryptConfiguration<
          RuntimeConfiguration["secrets"]
        >(JSON.parse(envelope) as EncryptedEnvelope, this.encryptionKey);
        // Pending cleanup belongs to the original destination. Never redirect it.
        if (await this.store.pendingProbe()) {
          const previous = normalizeSearchStaxSettings(secrets.searchstax);
          if (
            previous.updateEndpoint !== searchstax.updateEndpoint ||
            previous.selectEndpoint !== searchstax.selectEndpoint
          )
            throw new ApiError(
              409,
              "PROBE_CLEANUP_REQUIRED",
              "Cleanup is pending on the saved index. Keep its endpoints and update the token, then retry.",
            );
        }
        await this.checkSearchStaxConnection({
          ...searchstax,
          connectorKey: configuration.connectorKey,
        });
        envelope = JSON.stringify(
          await encryptConfiguration(
            { ...secrets, searchstax },
            this.encryptionKey,
          ),
        );
      }
      await this.store.saveConfiguration({
        ...configuration,
        credentialEnvelope: envelope,
        state: "destination_validated",
        updatedAt: new Date().toISOString(),
      });
      const result = await this.setup();
      this.startSetupReadiness();
      return result;
    } finally {
      this.savingSetup = false;
    }
  }

  async checkSearchStaxConnection(input: Record<string, unknown>) {
    await this.vendors.assertConnectorKeyAvailable(
      { settings: destination(input), deadlineAt: performance.now() + 20_000 },
      text(input, "connectorKey"),
      new Set(
        (await this.store.manifest()).map((record) => record.destinationId),
      ),
    );
  }

  constructor(
    private readonly store: ApplicationStateStore,
    private readonly lifecycle: LocalRunLifecycle,
    private readonly scheduler: LocalScheduler,
    private readonly loadRuntime: () => Promise<RuntimeConfiguration>,
    private readonly encryptionKey: string,
    private readonly dependencies: DependencyFactory,
    private readonly vendors: ApplicationVendors,
    private readonly target: "local" | "hosted",
    private readonly credentialCoordinator: CredentialCoordinator,
    private readonly webhookSigningSecret?: string,
    private readonly oauth?: OAuthAttempts,
  ) {}

  async setup() {
    const configuration = await this.store.configuration();
    const secrets = configuration
      ? await this.credentialCoordinator.secrets(
          configuration.credentialEnvelope,
        )
      : null;
    const auth = secrets?.zendesk as OAuthTokens | undefined;
    return {
      ...safeSetup(configuration),
      oauthAvailable: !!this.oauth,
      ...(auth
        ? {
            zendeskAccount: auth.accountSubdomain,
            zendeskAuth:
              auth.kind === "oauth"
                ? auth.health
                  ? ("reconnect_required" as const)
                  : ("oauth" as const)
                : ("legacy" as const),
          }
        : {}),
    };
  }

  async oauthStart(input: Record<string, unknown>, session: string) {
    if (!this.oauth)
      throw new ApiError(
        409,
        "OAUTH_UNAVAILABLE",
        "OAuth is not configured for this installation.",
      );
    const config = await this.store.configuration();
    const account = text(input, "accountSubdomain").toLowerCase();
    if (config) {
      const secrets = await this.credentialCoordinator.secrets(
        config.credentialEnvelope,
      );
      if (secrets.zendesk.accountSubdomain.toLowerCase() !== account)
        throw new ApiError(
          400,
          "ACCOUNT_MISMATCH",
          "Reconnect the configured Zendesk account.",
        );
    }
    this.oauth.discardSession(session);
    this.oauthCandidates.delete(session);
    return this.oauth.start(
      account,
      config ? "replace" : "setup",
      config?.revision ?? null,
      session,
    );
  }

  async oauthCallback(state: string, code: string, session: string) {
    if (!this.oauth)
      throw new ApiError(409, "OAUTH_UNAVAILABLE", "OAuth is unavailable.");
    const config = await this.store.configuration();
    const result = await this.oauth.complete(
      state,
      code,
      session,
      config?.revision ?? null,
    );
    if (this.oauthCandidates.size >= 100) {
      const oldest = this.oauthCandidates.keys().next().value;
      if (typeof oldest === "string") {
        this.oauth?.discardSession(oldest);
        this.oauthCandidates.delete(oldest);
      }
    }
    this.oauthCandidates.set(session, result.handle);
  }

  async oauthCancel(session: string) {
    this.oauth?.discardSession(session);
    this.oauthCandidates.delete(session);
  }

  async oauthCandidate(session: string) {
    const handle = this.oauthCandidates.get(session);
    if (!handle || !this.oauth) return null;
    try {
      const token = this.oauth.candidate(
        handle,
        session,
        (await this.store.configuration())?.revision ?? null,
      );
      return { handle, accountSubdomain: token.accountSubdomain };
    } catch {
      this.oauthCandidates.delete(session);
      return null;
    }
  }

  private async sourceClient(
    input: Record<string, unknown>,
  ): Promise<ZendeskClient> {
    if (!input.oauthHandle) return { credentials: credentials(input) };
    if (!this.oauth)
      throw new ApiError(409, "OAUTH_UNAVAILABLE", "OAuth is unavailable.");
    const configuration = await this.store.configuration();
    const token = this.oauth.candidate(
      text(input, "oauthHandle"),
      text(input, "_oauthSession"),
      configuration?.revision ?? null,
      configuration ? "replace" : "setup",
    );
    if (
      token.accountSubdomain !== text(input, "accountSubdomain").toLowerCase()
    )
      throw new ApiError(
        400,
        "ACCOUNT_MISMATCH",
        "The OAuth account did not match.",
      );
    return {
      credentials: token,
      authorization: this.oauth.candidateAuthorization(
        text(input, "oauthHandle"),
        text(input, "_oauthSession"),
        configuration?.revision ?? null,
        configuration ? "replace" : "setup",
      ),
    };
  }

  private claimOAuth(input: Record<string, unknown>, revision: number | null) {
    if (!this.oauth)
      throw new ApiError(409, "OAUTH_UNAVAILABLE", "OAuth is unavailable.");
    const handle = text(input, "oauthHandle");
    const session = text(input, "_oauthSession");
    const intent = revision === null ? "setup" : "replace";
    const candidate = this.oauth.candidate(handle, session, revision, intent);
    if (
      candidate.accountSubdomain !==
      text(input, "accountSubdomain").toLowerCase()
    )
      throw new ApiError(
        400,
        "ACCOUNT_MISMATCH",
        "The OAuth account did not match.",
      );
    // Claim before encryption/storage yields: no concurrent request can rotate
    // this pair after it has been selected for durable persistence.
    return this.oauth.claimCandidate(handle, session, revision, intent);
  }

  private consumeOAuth(input: {
    oauthHandle?: string;
    _oauthSession?: string;
  }) {
    if (input.oauthHandle) this.oauth?.consume(input.oauthHandle);
    if (input._oauthSession) this.oauthCandidates.delete(input._oauthSession);
  }

  async dashboard(): Promise<Dashboard> {
    const manifest = await this.store.manifest();
    const counts = new Map<string, number>();
    for (const record of manifest)
      counts.set(
        record.sourceIdentity.locale,
        (counts.get(record.sourceIdentity.locale) ?? 0) + 1,
      );
    const active = await this.store.activeRunDetails();
    return {
      setup: await this.setup(),
      scheduler: await this.scheduler.status(),
      manifestCounts: [...counts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([locale, count]) => ({ locale, count })),
      activeRun: active ? safeRun(active) : null,
      issues: (await this.store.issues())
        .filter((issue) => issue.state === "active")
        .map(safeIssue),
      incidents: (await this.store.incidents()).map(safeIncident),
    };
  }

  webhookStatus(): WebhookStatus {
    return {
      enabled: !!this.webhookSigningSecret,
      endpoint: "/api/webhooks/zendesk",
      requiresHttps: true,
      signingSecretConfigured: !!this.webhookSigningSecret,
    };
  }

  async receiveZendeskWebhook(
    rawBody: string,
    signature: string | null,
    timestamp: string | null,
    secure: boolean,
  ): Promise<WebhookResult> {
    if (!this.webhookSigningSecret)
      throw new ApiError(
        503,
        "WEBHOOK_NOT_CONFIGURED",
        "Realtime webhook delivery is not configured.",
      );
    if (!secure)
      throw new ApiError(
        400,
        "WEBHOOK_HTTPS_REQUIRED",
        "Realtime webhook delivery requires HTTPS.",
      );
    if (
      !verifyZendeskWebhookSignature(
        this.webhookSigningSecret,
        rawBody,
        signature,
        timestamp,
      )
    ) {
      console.warn("Zendesk webhook signature rejected.");
      throw new ApiError(
        401,
        "WEBHOOK_SIGNATURE_REJECTED",
        "Webhook signature was invalid.",
      );
    }
    let event;
    try {
      event = parseZendeskArticleWebhook(JSON.parse(rawBody));
    } catch (error) {
      if (
        error instanceof ContractError &&
        error.code === "UNSUPPORTED_WEBHOOK"
      ) {
        console.info("Unsupported Zendesk webhook event ignored.");
        return { accepted: false, ignored: "unsupported_event" };
      }
      throw new ApiError(
        400,
        "INVALID_WEBHOOK",
        "Webhook payload was invalid.",
      );
    }
    const runtime = await this.loadRuntime();
    const configuredLocales = new Set(
      runtime.reconciliation.locales.map((locale) => normalizeLocale(locale)),
    );
    const configuredLocale =
      event.locale === undefined
        ? null
        : configuredZendeskLocale(runtime.reconciliation.locales, event.locale);
    if (
      event.brandId !== runtime.brand.id ||
      (event.locale !== undefined &&
        (!configuredLocales.has(event.locale) || !configuredLocale))
    ) {
      console.info("Zendesk webhook article was outside configured scope.");
      return { accepted: false, ignored: "brand_or_locale_not_selected" };
    }
    const locales = configuredLocale
      ? [configuredLocale]
      : runtime.reconciliation.locales;
    return this.lifecycle
      .start("webhook", undefined, (current, runId) =>
        reconcileArticle(
          this.store,
          current.reconciliation,
          runId,
          event.articleId,
          locales,
          this.dependencies(current),
        ),
      )
      .then(({ runId }) => ({ accepted: true, runId }));
  }

  async runs(cursor?: string) {
    let before: { startedAt: string; id: string } | undefined;
    if (cursor) {
      try {
        before = JSON.parse(atob(cursor)) as { startedAt: string; id: string };
      } catch {
        throw new ApiError(400, "INVALID_CURSOR", "Run cursor was invalid.");
      }
      if (typeof before.startedAt !== "string" || typeof before.id !== "string")
        throw new ApiError(400, "INVALID_CURSOR", "Run cursor was invalid.");
    }
    const rows = await this.store.runHistory(before);
    const page = rows.slice(0, 25).map(safeRun);
    return {
      runs: page,
      ...(rows.length > 25 && page.at(-1)
        ? {
            nextCursor: btoa(
              JSON.stringify({
                startedAt: page.at(-1)!.startedAt,
                id: page.at(-1)!.id,
              }),
            ),
          }
        : {}),
    };
  }

  startRun() {
    return this.lifecycle.start();
  }

  async existingIndexDryRun() {
    const runtime = await this.loadRuntime();
    const dependencies = this.dependencies(runtime);
    if (!dependencies.discoverCandidates)
      throw new ApiError(
        501,
        "DRY_RUN_UNAVAILABLE",
        "Existing-index dry run is unavailable.",
      );
    return existingIndexDryRun(
      runtime.reconciliation,
      await this.store.manifest(),
      await this.store.manifestRevision(),
      {
        enumerate: dependencies.enumerate,
        discoverCandidates: dependencies.discoverCandidates,
      },
    );
  }

  async existingIndexApply(
    reviewedFingerprint: string,
    legacyIngestionPaused: boolean,
  ) {
    if (!legacyIngestionPaused)
      throw new ApiError(
        409,
        "LEGACY_INGESTION_NOT_PAUSED",
        "Confirm that legacy crawler or ingestion processes are paused or disabled before apply.",
      );
    const runtime = await this.loadRuntime();
    const dependencies = this.dependencies(runtime);
    if (!dependencies.discoverCandidates)
      throw new ApiError(
        501,
        "APPLY_UNAVAILABLE",
        "Existing-index apply is unavailable.",
      );
    const runId = randomUUID();
    if (
      !(await this.credentialCoordinator.exclusive(async () => {
        if (
          (await this.store.configuration())?.revision !==
          runtime.reconciliation.revision
        )
          return false;
        return admitReconciliation(
          this.store,
          runtime.reconciliation,
          runId,
          `existing-index-apply-${runId}`,
          async () => false,
        );
      }))
    )
      throw new ApiError(
        409,
        "RUN_ACTIVE",
        "A reconciliation is already active.",
      );
    const applyDependencies: ExistingIndexApplyDependencies = {
      enumerate: dependencies.enumerate,
      discoverCandidates: dependencies.discoverCandidates,
      upsert: dependencies.upsert,
      deleteExactIds: dependencies.deleteExactIds,
      acknowledge: (records) =>
        this.store.acknowledge(runId, records, new Date().toISOString()),
      manifest: () => this.store.manifest(),
      manifestRevision: () => this.store.manifestRevision(),
      ...(dependencies.destinationDocument
        ? { destinationDocument: dependencies.destinationDocument }
        : {}),
      configurationRevision: () => this.store.configurationRevision(),
    };
    try {
      const result = await existingIndexApply(
        runtime.reconciliation,
        await this.store.manifest(),
        await this.store.manifestRevision(),
        reviewedFingerprint,
        legacyIngestionPaused,
        applyDependencies,
      );
      const state =
        result.status === "applied"
          ? "succeeded"
          : result.status === "partial"
            ? "completed_with_errors"
            : "failed";
      await this.store.updateRun(
        runId,
        state,
        emptyCounts(),
        result.reasonCode,
      );
      await this.store.finish(runId, state);
      return result;
    } catch (error) {
      await this.store.updateRun(
        runId,
        "failed",
        emptyCounts(),
        error instanceof ContractError
          ? error.code
          : "EXISTING_INDEX_APPLY_FAILED",
      );
      await this.store.finish(runId, "failed");
      throw error;
    }
  }

  async setScheduler(enabled: boolean) {
    if (enabled) await this.loadRuntime();
    return this.scheduler.setEnabled(enabled);
  }

  private async recoveryProof(input: SetupInput): Promise<{
    plan: NamespaceRecoveryPlan;
    configuration: StoredConfiguration;
    records: StagedRecord[];
  }> {
    if (!(await this.store.recoveryAvailable()))
      throw new ApiError(
        409,
        "RECOVERY_STATE_NOT_EMPTY",
        "Namespace recovery requires empty local state.",
      );
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(input.connectorKey))
      throw new ApiError(400, "INVALID_INPUT", "Connector key was invalid.");
    const rawInput = { ...input } as Record<string, unknown>;
    const discovered = await this.validateZendesk(rawInput);
    const brand = discovered.brands.find((item) => item.id === input.brandId);
    if (!brand)
      throw new ApiError(
        400,
        "BRAND_UNAVAILABLE",
        "The selected brand was unavailable.",
      );
    const localeState = discovered.locales;
    const supported = new Set(
      localeState.filter((item) => item.supported).map((item) => item.locale),
    );
    const locales = [...new Set(input.locales)].sort();
    if (!locales.length || locales.some((locale) => !supported.has(locale)))
      throw new ApiError(
        400,
        "LOCALES_UNAVAILABLE",
        "Select at least one supported locale.",
      );
    const previewUrl = input.previewUrl ? new URL(input.previewUrl) : undefined;
    if (previewUrl && previewUrl.protocol !== "https:")
      throw new ApiError(
        400,
        "INVALID_PREVIEW_URL",
        "Preview URL must use HTTPS.",
      );
    const secrets = {
      zendesk: (await this.sourceClient(rawInput)).credentials,
      searchstax: destination(rawInput),
    };
    const runtime: RuntimeConfiguration = {
      reconciliation: {
        revision: 1,
        connectorKey: input.connectorKey,
        zendeskSubdomain: brand.subdomain,
        locales,
        target: this.target,
      },
      brand,
      secrets,
      zendeskAuthorization: (await this.sourceClient(rawInput)).authorization,
    };
    const dependencies = this.dependencies(runtime);
    const records: StagedRecord[] = [];
    const quarantined: QuarantinedRecord[] = [];
    for (const locale of locales)
      records.push(
        ...(await dependencies.enumerate(
          locale,
          async () => undefined,
          (record) => quarantined.push(record),
        )),
      );
    const ids = new Set(records.map((record) => record.id));
    if (
      quarantined.length ||
      records.length > 5_000 ||
      ids.size !== records.length ||
      records.some(
        (record) => !record.id.startsWith(`zdg_${input.connectorKey}_`),
      )
    )
      throw new ApiError(
        409,
        "RECOVERY_SOURCE_UNSAFE",
        "Namespace recovery requires one complete healthy source corpus.",
      );
    if (!records.length)
      throw new ApiError(
        409,
        "RECOVERY_NAMESPACE_EMPTY",
        "Use ordinary setup for an empty connector namespace.",
      );
    createUpsertBatches(records);
    await dependencies.verifyFields(records, async () => undefined);
    await dependencies.verify(records, async () => undefined);
    const plan = {
      recordCount: records.length,
      fingerprint: await fingerprint({
        connectorKey: input.connectorKey,
        brandId: brand.id,
        locales,
        updateEndpoint: input.updateEndpoint,
        selectEndpoint: input.selectEndpoint,
        destinationName: input.destinationName,
        records: records
          .map((record) => [record.id, record.hash])
          .sort(([left], [right]) => left.localeCompare(right)),
      }),
    };
    const timestamp = new Date().toISOString();
    return {
      plan,
      records,
      configuration: {
        revision: 1,
        state: "locked_after_first_success",
        connectorKey: input.connectorKey,
        brandId: brand.id,
        brandName: brand.name,
        brandSubdomain: brand.subdomain,
        selectedLocales: locales,
        destinationName: input.destinationName,
        ...(previewUrl ? { previewUrl: previewUrl.href } : {}),
        target: this.target,
        credentialEnvelope: JSON.stringify(
          await encryptConfiguration(secrets, this.encryptionKey),
        ),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };
  }

  async planRecovery(input: SetupInput) {
    return (await this.recoveryProof(input)).plan;
  }

  async applyRecovery(input: SetupInput, suppliedFingerprint: string) {
    const proof = await this.recoveryProof(input);
    if (proof.plan.fingerprint !== suppliedFingerprint)
      throw new ApiError(
        409,
        "RECOVERY_PLAN_MISMATCH",
        "The exact namespace recovery plan did not match.",
      );
    await this.credentialCoordinator.exclusive(async () => {
      if (await this.store.configuration())
        throw new ApiError(
          409,
          "ALREADY_CONFIGURED",
          "Setup was already complete.",
        );
      if (input.oauthHandle) {
        const saved = await this.credentialCoordinator.secrets(
          proof.configuration.credentialEnvelope,
        );
        const zendesk = this.claimOAuth({ ...input }, null);
        proof.configuration = {
          ...proof.configuration,
          credentialEnvelope: JSON.stringify(
            await encryptConfiguration(
              { ...saved, zendesk },
              this.encryptionKey,
            ),
          ),
        };
      }
      await this.store.adoptNamespace(
        proof.configuration,
        proof.records,
        randomUUID(),
        proof.configuration.updatedAt,
      );
    });
    this.consumeOAuth(input);
    return this.setup();
  }

  cancelRun(runId: string) {
    return this.lifecycle.cancel(runId);
  }

  confirmDeletion(planId: string, fingerprint: string) {
    return this.lifecycle.confirm(planId, fingerprint);
  }

  async deletionPlan(planId: string) {
    const plan = await this.store.deletionPlan(planId);
    if (!plan)
      throw new ApiError(404, "PLAN_NOT_FOUND", "Deletion plan was not found.");
    return {
      id: plan.id,
      runId: plan.runId,
      staleCount: plan.exactIds.length,
      exactIds: plan.exactIds,
      state: plan.state,
      fingerprint: plan.fingerprint,
    };
  }

  async validateZendesk(input: Record<string, unknown>) {
    const client = {
      ...(await this.sourceClient(input)),
      deadlineAt: performance.now() + 20_000,
    };
    const brands = await this.vendors.discoverBrands(client);
    const brandId =
      typeof input.brandId === "string" ? input.brandId : undefined;
    const selected = brandId
      ? brands.find((brand) => brand.id === brandId)
      : undefined;
    if (brandId && !selected)
      throw new ApiError(
        400,
        "BRAND_UNAVAILABLE",
        "The selected brand was unavailable.",
      );
    return {
      brands,
      locales: selected
        ? await this.vendors.discoverLocales(client, selected)
        : [],
    };
  }

  async validateSearchStax(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (this.activeReadiness)
      throw new ApiError(
        409,
        "READINESS_ACTIVE",
        "A SearchStax readiness validation is already running.",
      );
    const startedAt = Date.now();
    const monotonicStart = performance.now();
    this.activeReadiness = {
      phase: "checking_namespace",
      startedAt: new Date(startedAt).toISOString(),
      deadlineAt: new Date(
        startedAt + READINESS_TOTAL_DEADLINE_MS,
      ).toISOString(),
    };
    try {
      const manifest = await this.store.manifest();
      const client = {
        settings: destination(input),
        signal,
        sleep: (milliseconds: number) =>
          new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            const onAbort = () => {
              clearTimeout(timer);
              reject(signal?.reason);
            };
            const timer = setTimeout(() => {
              signal?.removeEventListener("abort", onAbort);
              resolve();
            }, milliseconds);
            signal?.addEventListener("abort", onAbort, { once: true });
          }),
        now: () => performance.now(),
        deadlineAt: monotonicStart + READINESS_VISIBILITY_DEADLINE_MS,
        cleanupDeadlineAt: monotonicStart + READINESS_TOTAL_DEADLINE_MS,
      };
      await this.vendors.assertConnectorKeyAvailable(
        client,
        text(input, "connectorKey"),
        new Set(manifest.map((record) => record.destinationId)),
      );
      await this.vendors.readinessProbe(
        client,
        pendingProbeStore(this.store),
        undefined,
        (phase) => {
          if (this.activeReadiness)
            this.activeReadiness = { ...this.activeReadiness, phase };
        },
      );
    } catch (error) {
      if (error instanceof ContractError && error.code === "REQUEST_DEADLINE")
        throw new ContractError(
          "READINESS_TIMEOUT",
          "SearchStax readiness validation timed out. Try again.",
        );
      throw error;
    } finally {
      this.activeReadiness = null;
    }
  }

  async readinessStatus() {
    return this.activeReadiness;
  }

  async completeSetup(input: SetupInput) {
    if (this.savingSetup || this.setupTask || this.closing)
      throw new ApiError(
        409,
        "READINESS_ACTIVE",
        "Setup is already being saved. Refresh the dashboard.",
      );
    this.savingSetup = true;
    try {
      return await this.saveSetup(input);
    } finally {
      this.savingSetup = false;
    }
  }

  private async saveSetup(input: SetupInput) {
    if ((await this.store.configuration()) !== null)
      throw new ApiError(
        409,
        "ALREADY_CONFIGURED",
        "Setup was already complete.",
      );
    const rawInput = { ...input } as Record<string, unknown>;
    const zendesk = await this.validateZendesk(rawInput);
    const brand = zendesk.brands.find((item) => item.id === input.brandId);
    if (!brand)
      throw new ApiError(
        400,
        "BRAND_UNAVAILABLE",
        "The selected brand was unavailable.",
      );
    const localeState = await this.vendors.discoverLocales(
      {
        ...(await this.sourceClient(rawInput)),
        deadlineAt: performance.now() + 20_000,
      },
      brand,
    );
    const supported = new Set(
      localeState.filter((item) => item.supported).map((item) => item.locale),
    );
    const locales = [...new Set(input.locales)].sort();
    if (!locales.length || locales.some((locale) => !supported.has(locale)))
      throw new ApiError(
        400,
        "LOCALES_UNAVAILABLE",
        "Select at least one supported locale.",
      );
    await this.checkSearchStaxConnection(rawInput);
    const previewUrl = input.previewUrl ? new URL(input.previewUrl) : undefined;
    if (previewUrl && previewUrl.protocol !== "https:")
      throw new ApiError(
        400,
        "INVALID_PREVIEW_URL",
        "Preview URL must use HTTPS.",
      );
    await this.credentialCoordinator.exclusive(async () => {
      if (await this.store.configuration())
        throw new ApiError(
          409,
          "ALREADY_CONFIGURED",
          "Setup was already complete.",
        );
      const zendesk = input.oauthHandle
        ? this.claimOAuth(rawInput, null)
        : credentials(rawInput);
      const now = new Date().toISOString();
      await this.store.saveConfiguration({
        revision: 1,
        state: "destination_validated",
        connectorKey: input.connectorKey,
        brandId: brand.id,
        brandName: brand.name,
        brandSubdomain: brand.subdomain,
        selectedLocales: locales,
        destinationName: input.destinationName,
        ...(previewUrl ? { previewUrl: previewUrl.href } : {}),
        target: this.target,
        credentialEnvelope: JSON.stringify(
          await encryptConfiguration(
            {
              zendesk,
              searchstax: destination(rawInput),
            },
            this.encryptionKey,
          ),
        ),
        createdAt: now,
        updatedAt: now,
      });
    });
    this.consumeOAuth(input);
    const result = await this.setup();
    this.startSetupReadiness();
    return result;
  }

  async replaceZendesk(input: Record<string, unknown>) {
    const runtime = await this.loadRuntime();
    const client = await this.sourceClient(input);
    const zendesk = client.credentials;
    if (
      zendesk.accountSubdomain.toLowerCase() !==
      runtime.secrets.zendesk.accountSubdomain.toLowerCase()
    )
      throw new ApiError(
        400,
        "ACCOUNT_MISMATCH",
        "Reconnect the configured account.",
      );
    const brands = await this.vendors.discoverBrands(client);
    const brand = brands.find((item) => item.id === runtime.brand.id);
    if (!brand || brand.subdomain !== runtime.brand.subdomain)
      throw new ApiError(
        400,
        "BRAND_UNAVAILABLE",
        "The configured brand was unavailable.",
      );
    const locales = await this.vendors.discoverLocales(client, brand);
    const supported = new Set(
      locales
        .filter((locale) => locale.supported)
        .map((locale) => locale.locale),
    );
    if (runtime.reconciliation.locales.some((locale) => !supported.has(locale)))
      throw new ApiError(
        400,
        "LOCALES_UNAVAILABLE",
        "The replacement account cannot read every selected locale.",
      );
    const result = await this.replaceSecrets(
      { ...runtime.secrets, zendesk },
      "zendesk",
      runtime.reconciliation.revision,
      input.oauthHandle ? input : undefined,
    );
    this.consumeOAuth(input);
    return result;
  }

  async replaceSearchStax(input: Record<string, unknown>) {
    const runtime = await this.loadRuntime();
    await this.validateSearchStax({
      ...input,
      connectorKey: runtime.reconciliation.connectorKey,
    });
    return this.replaceSecrets(
      {
        ...runtime.secrets,
        searchstax: destination(input),
      },
      "searchstax",
      runtime.reconciliation.revision,
    );
  }

  private async replaceSecrets(
    secrets: RuntimeConfiguration["secrets"],
    kind: "zendesk" | "searchstax",
    revision: number,
    oauthInput?: Record<string, unknown>,
  ) {
    return this.credentialCoordinator.exclusive(async () => {
      const configuration = await this.store.configuration();
      if (!configuration || configuration.revision !== revision)
        throw new ApiError(
          409,
          "CONFIGURATION_CHANGED",
          "Configuration changed. Retry credential replacement.",
        );
      if (
        (await this.store.activeRun()) ||
        this.setupTask ||
        this.activeReadiness ||
        this.savingSetup
      )
        throw new ApiError(
          409,
          "RUN_ACTIVE",
          "Wait for active work before replacing credentials.",
        );
      const current = await this.credentialCoordinator.secrets(
        configuration.credentialEnvelope,
      );
      const replacement = oauthInput
        ? this.claimOAuth(oauthInput, revision)
        : secrets[kind];
      await this.store.saveConfiguration({
        ...configuration,
        revision: configuration.revision + 1,
        credentialEnvelope: JSON.stringify(
          await encryptConfiguration(
            { ...current, [kind]: replacement },
            this.encryptionKey,
          ),
        ),
        updatedAt: new Date().toISOString(),
      });
      return this.setup();
    });
  }

  async planLocales(locales: string[]) {
    const configuration = await this.store.configuration();
    if (!configuration)
      throw new ApiError(409, "SETUP_REQUIRED", "Complete setup first.");
    const selected = [...new Set(locales)].sort();
    if (!selected.length)
      throw new ApiError(400, "INVALID_INPUT", "Select at least one locale.");
    const runtime = await this.loadRuntime();
    const available = await this.vendors.discoverLocales(
      {
        credentials: runtime.secrets.zendesk,
        authorization: runtime.zendeskAuthorization,
      },
      runtime.brand,
    );
    const supported = new Set(
      available
        .filter((locale) => locale.supported)
        .map((locale) => locale.locale),
    );
    if (selected.some((locale) => !supported.has(locale)))
      throw new ApiError(
        400,
        "LOCALES_UNAVAILABLE",
        "The locale plan included an unsupported or unavailable locale.",
      );
    const manifest = await this.store.manifest();
    const removedRecordCount = manifest.filter(
      (record) => !selected.includes(record.sourceIdentity.locale),
    ).length;
    const plan = {
      id: randomUUID(),
      configRevision: configuration.revision,
      selectedLocales: selected,
      removedRecordCount,
      fingerprint: await fingerprint({
        revision: configuration.revision,
        selected,
        removedRecordCount,
      }),
      state: "pending" as const,
      createdAt: new Date().toISOString(),
    };
    await this.store.saveLocalePlan(plan);
    return {
      id: plan.id,
      locales: plan.selectedLocales,
      removedRecordCount: plan.removedRecordCount,
      fingerprint: plan.fingerprint,
    };
  }

  async applyLocales(planId: string, suppliedFingerprint: string) {
    return this.credentialCoordinator.exclusive(() =>
      this.applyLocalesExclusive(planId, suppliedFingerprint),
    );
  }
  private async applyLocalesExclusive(
    planId: string,
    suppliedFingerprint: string,
  ) {
    if (
      (await this.store.applyLocalePlan(planId, suppliedFingerprint)) !==
      "applied"
    )
      throw new ApiError(
        409,
        "STALE_LOCALE_PLAN",
        "The locale plan is stale or does not match.",
      );
    return this.setup();
  }
}

export interface NodeApplicationOptions {
  store: ApplicationStateStore;
  encryptionKey: string;
  assetRoot: string;
  port?: number;
  dependencies?: DependencyFactory;
  vendors?: ApplicationVendors;
  schedulerTiming?: SchedulerTiming;
  http?: HttpHostOptions;
  target?: "local" | "hosted";
  oauth?: OAuthSettings;
  oauthFetch?: typeof fetch;
  webhookSigningSecret?: string;
}

export async function startNodeApplication(options: NodeApplicationOptions) {
  const store = options.store;
  const transport = options.oauth
    ? new OAuthTransport(options.oauth, options.oauthFetch)
    : undefined;
  const coordinator = new CredentialCoordinator(
    store,
    options.encryptionKey,
    transport,
  );
  const attempts =
    transport && options.oauth ? new OAuthAttempts(transport) : undefined;
  const loadRuntime = async () => {
    const runtime = await runtimeConfiguration(store, options.encryptionKey);
    if ((runtime.secrets.zendesk as OAuthTokens).kind === "oauth")
      runtime.zendeskAuthorization = coordinator.provider(
        runtime.secrets.zendesk.accountSubdomain,
        runtime.reconciliation.revision,
      );
    return runtime;
  };
  const dependencies = options.dependencies ?? reconciliationDependencies;
  const lifecycle = new LocalRunLifecycle(
    store,
    loadRuntime,
    dependencies,
    coordinator,
  );
  await lifecycle.recover();
  await store.pruneHistory();
  const scheduler = new LocalScheduler(
    store,
    lifecycle,
    options.schedulerTiming ?? defaultSchedulerTiming,
  );
  const service = new NodeApplicationService(
    store,
    lifecycle,
    scheduler,
    loadRuntime,
    options.encryptionKey,
    dependencies,
    options.vendors ?? applicationVendors,
    options.target ?? "local",
    coordinator,
    options.webhookSigningSecret,
    attempts,
  );
  let host: Awaited<ReturnType<typeof startLoopbackHost>> | undefined;
  try {
    host = await startLoopbackHost(
      service,
      options.assetRoot,
      options.port,
      options.http,
    );
    await service.resumeSetup();
    await scheduler.start();
    const startedHost = host;
    return {
      origin: startedHost.origin,
      async close() {
        await scheduler.close();
        await startedHost.close();
        await service.close();
        await lifecycle.close();
      },
    };
  } catch (error) {
    await scheduler.close();
    await host?.close();
    await service.close();
    await lifecycle.close();
    throw error;
  }
}
