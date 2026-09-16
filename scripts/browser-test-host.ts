import { startLoopbackHost } from "../node/http-host.ts";
import type { ApplicationService, SafeSetup } from "../worker/api/types.ts";

const setup: SafeSetup = {
  configured: false,
  state: "unconfigured",
  zendeskConfigured: false,
  searchstaxConfigured: false,
};

const service: ApplicationService = {
  setup: async () => setup,
  validateZendesk: async () => ({ brands: [], locales: [] }),
  checkSearchStaxConnection: async () => undefined,
  retrySetup: async () => {
    throw new Error("Unused fixture");
  },
  validateSearchStax: async () => undefined,
  readinessStatus: async () => null,
  completeSetup: async () => setup,
  planRecovery: async () => ({ recordCount: 1, fingerprint: "fingerprint" }),
  applyRecovery: async () => setup,
  replaceZendesk: async () => setup,
  replaceSearchStax: async () => setup,
  dashboard: async () => ({
    setup,
    manifestCounts: [],
    activeRun: null,
    scheduler: { state: "disabled", retryAttempt: 0 },
    issues: [],
    incidents: [],
  }),
  setScheduler: async (enabled) => ({
    state: enabled ? "enabled" : "paused",
    retryAttempt: 0,
    ...(enabled ? {} : { pauseReason: "operator" as const }),
  }),
  runs: async () => ({ runs: [] }),
  startRun: async () => ({ runId: "browser-test-run" }),
  existingIndexDryRun: async () => ({
    readOnly: true,
    fingerprint: "browser-test-fingerprint",
    fieldAvailability: {
      url: { state: "queryable" },
      url_s: { state: "queryable" },
      ss_url: { state: "queryable" },
    } as const,
    counts: {
      sourceIdentities: 0,
      candidates: 0,
      managed: 0,
      adopt: 0,
      consolidate: 0,
      create: 0,
      ambiguousUnmatched: 0,
    },
    actions: [],
  }),
  existingIndexApply: async (fingerprint) => ({
    status: "applied",
    reviewedFingerprint: fingerprint,
    recomputedFingerprint: fingerprint,
    counts: {
      managed: 0,
      adopted: 0,
      created: 0,
      consolidated: 0,
      redundantDeleted: 0,
      failedWrites: 0,
      failedRedundantDeletes: 0,
      unresolvedResiduals: 0,
      ambiguousUnmatched: 0,
    },
    unresolvedResiduals: [],
    finalVerification: "passed",
  }),
  cancelRun: async () => undefined,
  planLocales: async (locales) => ({
    id: "browser-test-plan",
    locales,
    removedRecordCount: 0,
    fingerprint: "browser-test-fingerprint",
  }),
  applyLocales: async () => setup,
  deletionPlan: async (id) => ({
    id,
    runId: "browser-test-run",
    staleCount: 0,
    exactIds: [],
    state: "pending",
    fingerprint: "browser-test-fingerprint",
  }),
  confirmDeletion: async () => undefined,
};

const host = await startLoopbackHost(
  service,
  "dist/client",
  Number(process.env.BROWSER_TEST_PORT ?? "4173"),
);
console.log(`Browser test host listening at ${host.origin}`);

async function close() {
  await host.close();
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
