import {
  createUpsertBatches,
  isGeneratedDestinationId,
  isSafeDestinationId,
} from "../contracts/searchstax.ts";
import {
  normalizeLocale,
  prepareRecordForDestinationId,
} from "../contracts/record.ts";
import { ContractError } from "../contracts/shared.ts";
import type { ExistingIndexCandidateDiscovery } from "./existing-index-dry-run.ts";
import {
  emptyCounts,
  type DeletionPlan,
  type ReconciliationConfig,
  type ReconciliationStore,
  type ManifestRecord,
  type QuarantinedRecord,
  type RunCounts,
  type RunRecord,
  type StagedRecord,
  canonicalZendeskSourceIdentity,
  sourceIdentityKey,
} from "./model.ts";

const MAX_RECORDS = { hosted: 500, local: 5_000 } as const;
const MAX_DELETE_BATCH = 500;

class CanceledRun extends Error {}

export interface ReconciliationDependencies {
  enumerate(
    locale: string,
    checkpoint: () => Promise<void>,
    quarantine: (record: QuarantinedRecord) => void,
    articleId?: string,
  ): Promise<readonly StagedRecord[]>;
  upsert(records: readonly StagedRecord[]): Promise<void>;
  deleteExactIds(
    ids: readonly string[],
    trustedManagedIds?: ReadonlySet<string>,
  ): Promise<void>;
  destinationIds(checkpoint: () => Promise<void>): Promise<readonly string[]>;
  destinationDocument?: (
    id: string,
  ) => Promise<Record<string, import("../contracts/record.ts").Json> | null>;
  discoverCandidates?: (
    checkpoint: () => Promise<void>,
    sourceUrls?: readonly string[],
  ) => Promise<ExistingIndexCandidateDiscovery>;
  destinationProof?: (
    ids: readonly string[],
    checkpoint: () => Promise<void>,
  ) => Promise<string>;
  verifyFields(
    records: readonly StagedRecord[],
    checkpoint: () => Promise<void>,
  ): Promise<void>;
  verify(
    records: readonly StagedRecord[],
    checkpoint: () => Promise<void>,
    preservedIds?: readonly string[],
    optionalIds?: readonly string[],
  ): Promise<void>;
  now?: () => string;
  randomId?: () => string;
}

export interface ReconciliationResult {
  runId: string;
  state:
    | "succeeded"
    | "completed_with_errors"
    | "degraded"
    | "guarded"
    | "action_required"
    | "canceled"
    | "failed";
  counts: RunCounts;
  deletionPlan?: DeletionPlan;
}

function now(dependencies: ReconciliationDependencies): string {
  return (dependencies.now ?? (() => new Date().toISOString()))();
}

function randomId(dependencies: ReconciliationDependencies): string {
  return (dependencies.randomId ?? (() => crypto.randomUUID()))();
}

function elapsed(startedAt: string, finishedAt: string): number {
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(duration)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, duration))
    : 0;
}

async function telemetry(
  store: ReconciliationStore,
  dependencies: ReconciliationDependencies,
  runId: string,
  phase: string,
  event: string,
  visibility: "operator" | "diagnostic",
  details: {
    attempt?: number;
    batchNumber?: number;
    recordCount?: number;
    durationMs?: number;
  } = {},
) {
  await store.appendTelemetry({
    runId,
    phase,
    event,
    visibility,
    ...details,
    createdAt: now(dependencies),
  });
}

async function phaseStarted(
  store: ReconciliationStore,
  dependencies: ReconciliationDependencies,
  runId: string,
  phase: string,
) {
  await telemetry(
    store,
    dependencies,
    runId,
    phase,
    "phase_started",
    "diagnostic",
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sourceFingerprint(
  records: readonly StagedRecord[],
  quarantined: readonly QuarantinedRecord[] = [],
  subdomain?: string,
) {
  return sha256(
    JSON.stringify(
      [
        ...records.map(
          ({ sourceIdentity, hash }) =>
            [sourceIdentityKey(sourceIdentity), hash] as const,
        ),
        ...quarantined.map(
          (record) =>
            [
              subdomain
                ? sourceIdentityKey(
                    canonicalZendeskSourceIdentity(
                      subdomain,
                      record.articleId,
                      record.locale,
                    ),
                  )
                : record.id,
              null,
            ] as const,
        ),
      ].sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

async function manifestFingerprint(records: readonly ManifestRecord[]) {
  return sha256(
    JSON.stringify(
      records
        .map((record) => [
          sourceIdentityKey(record.sourceIdentity),
          record.destinationId,
          record.hash,
        ])
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

async function destinationFingerprint(
  dependencies: ReconciliationDependencies,
  ids: readonly string[],
  checkpoint: () => Promise<void>,
): Promise<string> {
  if (dependencies.destinationProof)
    return dependencies.destinationProof(ids, checkpoint);
  return sha256(JSON.stringify([...ids].sort()));
}

async function planFingerprint(
  ids: readonly string[],
  configRevision: number,
  manifestRevision: number,
  manifest: string,
  source: string,
  destination: string,
) {
  return sha256(
    JSON.stringify({
      configRevision,
      exactIds: [...ids].sort(),
      destinationFingerprint: destination,
      manifestFingerprint: manifest,
      manifestRevision,
      sourceFingerprint: source,
    }),
  );
}

async function checkpoint(
  store: ReconciliationStore,
  runId: string,
  configRevision: number,
): Promise<void> {
  if ((await store.configurationRevision()) !== configRevision) {
    throw new ContractError(
      "CONFIGURATION_REVISION_MISMATCH",
      "Configuration changed during reconciliation.",
    );
  }
  if ((await store.run(runId))?.state === "cancel_requested") {
    throw new CanceledRun();
  }
}

function validateStaged(records: readonly StagedRecord[], limit: number): void {
  if (records.length > limit) {
    throw new ContractError(
      "CORPUS_LIMIT_EXCEEDED",
      "The complete source exceeded the configured execution target.",
    );
  }
  const destinationIds = new Set<string>();
  const sourceIds = new Set<string>();
  for (const record of records) {
    if (destinationIds.has(record.destinationId))
      throw new ContractError(
        "DUPLICATE_STABLE_ID",
        "The complete source contained a duplicate stable ID.",
      );
    destinationIds.add(record.destinationId);
    const sourceId = sourceIdentityKey(record.sourceIdentity);
    if (sourceIds.has(sourceId))
      throw new ContractError(
        "DUPLICATE_SOURCE_IDENTITY",
        "The complete source contained a duplicate source identity.",
      );
    sourceIds.add(sourceId);
  }
  // This also performs the exact SearchStax UTF-8 request preflight.
  createUpsertBatches(records);
}

function validateDestinationIds(
  ids: readonly string[],
  limit: number,
): Set<string> {
  if (
    !Array.isArray(ids) ||
    ids.length > limit ||
    ids.some(
      (id) => typeof id !== "string" || !isSafeDestinationId(id as string),
    ) ||
    new Set(ids).size !== ids.length
  )
    throw new ContractError(
      "INVALID_RESPONSE",
      "The complete connector-owned destination inventory was invalid.",
    );
  return new Set(ids);
}

function validateManifest(
  manifest: readonly ManifestRecord[],
  subdomain: string,
): void {
  const destinationIds = new Set<string>();
  const sourceIds = new Set<string>();
  for (const record of manifest) {
    if (!isSafeDestinationId(record.destinationId))
      throw new ContractError(
        "INVALID_RESPONSE",
        "Managed destination state contained an unsafe ID.",
      );
    if (destinationIds.has(record.destinationId))
      throw new ContractError(
        "INVALID_RESPONSE",
        "Managed destination state contained a duplicate destination ID.",
      );
    destinationIds.add(record.destinationId);
    const sourceId = sourceIdentityKey(record.sourceIdentity);
    if (
      sourceId !==
      sourceIdentityKey(
        canonicalZendeskSourceIdentity(
          subdomain,
          record.sourceIdentity.articleId,
          record.sourceIdentity.locale,
        ),
      )
    )
      throw new ContractError(
        "INVALID_RESPONSE",
        "Managed destination state contained a conflicting source identity.",
      );
    if (sourceIds.has(sourceId))
      throw new ContractError(
        "INVALID_RESPONSE",
        "Managed destination state contained a duplicate source identity.",
      );
    sourceIds.add(sourceId);
  }
}

async function adoptManifestDestinationIds(
  records: readonly StagedRecord[],
  manifestBySource: ReadonlyMap<string, ManifestRecord>,
  manifestByDestination: ReadonlyMap<string, string>,
): Promise<StagedRecord[]> {
  const adopted = await Promise.all(
    records.map(async (record) => {
      const prior = manifestBySource.get(
        sourceIdentityKey(record.sourceIdentity),
      );
      const sourceId = sourceIdentityKey(record.sourceIdentity);
      const generatedOwner = manifestByDestination.get(record.destinationId);
      const adoptedOwner = manifestByDestination.get(
        prior?.destinationId ?? "",
      );
      if (
        (generatedOwner !== undefined && generatedOwner !== sourceId) ||
        (adoptedOwner !== undefined && adoptedOwner !== sourceId)
      )
        throw new ContractError(
          "DUPLICATE_STABLE_ID",
          "The complete source conflicted with managed destination ownership.",
        );
      if (!prior || prior.destinationId === record.destinationId) return record;
      const prepared = await prepareRecordForDestinationId(
        record,
        prior.destinationId,
      );
      return { ...record, ...prepared, destinationId: prior.destinationId };
    }),
  );
  const destinationIds = new Set<string>();
  for (const record of adopted) {
    if (destinationIds.has(record.destinationId))
      throw new ContractError(
        "DUPLICATE_STABLE_ID",
        "The complete source conflicted with managed destination IDs.",
      );
    destinationIds.add(record.destinationId);
  }
  return adopted;
}

function validateSourceIdentities(
  subdomain: string,
  seenIds: Set<string>,
  records: readonly StagedRecord[],
  quarantined: readonly QuarantinedRecord[],
  limit: number,
): void {
  if (seenIds.size + records.length + quarantined.length > limit)
    throw new ContractError(
      "CORPUS_LIMIT_EXCEEDED",
      "The complete source exceeded the configured execution target.",
    );
  for (const record of [...records, ...quarantined]) {
    const sourceId = sourceIdentityKey(
      canonicalZendeskSourceIdentity(
        subdomain,
        record.articleId,
        record.locale,
      ),
    );
    if (seenIds.has(sourceId))
      throw new ContractError(
        "DUPLICATE_STABLE_ID",
        "The complete source contained a duplicate stable ID.",
      );
    seenIds.add(sourceId);
  }
}

function shouldGuard(staleCount: number, priorCount: number): boolean {
  return staleCount > 100 || (priorCount > 0 && staleCount * 5 > priorCount);
}

function safeFailureCode(error: unknown): string {
  if (error instanceof ContractError) return error.code;
  return "RECONCILIATION_FAILED";
}

export async function admitReconciliation(
  store: ReconciliationStore,
  config: ReconciliationConfig,
  runId: string,
  workflowId: string,
  isWorkflowTerminal: (workflowId: string) => Promise<boolean>,
): Promise<boolean> {
  const active = await store.activeRun();
  if (active) {
    if (!(await isWorkflowTerminal(active.workflowId))) return false;
    await store.abandonRun(active.id);
  }
  const run: RunRecord = {
    id: runId,
    workflowId,
    configRevision: config.revision,
    state: "queued",
    counts: emptyCounts(),
  };
  return store.admitRun(run);
}

export async function reconcile(
  store: ReconciliationStore,
  config: ReconciliationConfig,
  runId: string,
  dependencies: ReconciliationDependencies,
): Promise<ReconciliationResult> {
  const counts = emptyCounts();
  const startedAt = now(dependencies);
  try {
    await checkpoint(store, runId, config.revision);
    await store.clearStaging(runId);
    const manifest = await store.manifest();
    validateManifest(manifest, config.zendeskSubdomain);
    const previous = new Map(
      manifest.map((entry) => [sourceIdentityKey(entry.sourceIdentity), entry]),
    );
    const manifestByDestination = new Map(
      manifest.map((entry) => [
        entry.destinationId,
        sourceIdentityKey(entry.sourceIdentity),
      ]),
    );
    await store.updateRun(runId, "enumerating", counts);
    await phaseStarted(store, dependencies, runId, "enumerating");

    const sourceIds = new Set<string>();
    const quarantined: QuarantinedRecord[] = [];
    for (const locale of config.locales) {
      await checkpoint(store, runId, config.revision);
      const quarantineOffset = quarantined.length;
      const records = await dependencies.enumerate(
        locale,
        () => checkpoint(store, runId, config.revision),
        (record) => quarantined.push(record),
      );
      const adoptedRecords = await adoptManifestDestinationIds(
        records,
        previous,
        manifestByDestination,
      );
      validateSourceIdentities(
        config.zendeskSubdomain,
        sourceIds,
        adoptedRecords,
        quarantined.slice(quarantineOffset),
        MAX_RECORDS[config.target],
      );
      await store.stage(runId, adoptedRecords);
    }

    await checkpoint(store, runId, config.revision);
    await store.updateRun(runId, "planning", counts);
    await phaseStarted(store, dependencies, runId, "planning");
    const staged = await store.staged(runId);
    validateStaged(staged, MAX_RECORDS[config.target]);
    const destinationIds = validateDestinationIds(
      await dependencies.destinationIds(() =>
        checkpoint(store, runId, config.revision),
      ),
      MAX_RECORDS[config.target],
    );
    await store.syncIssues(
      runId,
      config.locales.map(normalizeLocale),
      quarantined,
      now(dependencies),
    );
    const current = new Set([
      ...staged.map((record) => sourceIdentityKey(record.sourceIdentity)),
      ...quarantined.map((record) =>
        sourceIdentityKey(
          canonicalZendeskSourceIdentity(
            config.zendeskSubdomain,
            record.articleId,
            record.locale,
          ),
        ),
      ),
    ]);
    const created = staged.filter(
      (record) => !previous.has(sourceIdentityKey(record.sourceIdentity)),
    );
    const changed = staged.filter((record) => {
      const prior = previous.get(sourceIdentityKey(record.sourceIdentity));
      return (
        prior !== undefined &&
        (prior.hash !== record.hash ||
          !destinationIds.has(record.destinationId))
      );
    });
    const unchanged = staged.filter(
      (record) =>
        previous.get(sourceIdentityKey(record.sourceIdentity))?.hash ===
          record.hash && destinationIds.has(record.destinationId),
    );
    const destinationRepairs = staged.filter(
      (record) =>
        previous.get(sourceIdentityKey(record.sourceIdentity))?.hash ===
          record.hash && !destinationIds.has(record.destinationId),
    );
    const stale = manifest
      .filter(
        (record) => !current.has(sourceIdentityKey(record.sourceIdentity)),
      )
      .map((record) => record.destinationId)
      .sort();
    Object.assign(counts, {
      source: staged.length + quarantined.length,
      created: created.length,
      changed: changed.length,
      unchanged: unchanged.length,
      stale: stale.length,
      plannedDeletions: stale.length,
      warnings: staged.filter((record) => record.warnings.length > 0).length,
      quarantined: quarantined.length,
    });
    if (destinationRepairs.length)
      await telemetry(
        store,
        dependencies,
        runId,
        "planning",
        "destination_repair_planned",
        "diagnostic",
        { recordCount: destinationRepairs.length },
      );

    const requiredWrites = [...created, ...changed].sort((left, right) =>
      left.destinationId.localeCompare(right.destinationId),
    );
    const batches = createUpsertBatches(requiredWrites);
    await store.updateRun(runId, "writing", counts);
    await phaseStarted(store, dependencies, runId, "writing");
    for (const [index, batch] of batches.entries()) {
      await checkpoint(store, runId, config.revision);
      const batchStartedAt = now(dependencies);
      await dependencies.upsert(batch.records as readonly StagedRecord[]);
      await store.acknowledge(
        runId,
        batch.records as readonly StagedRecord[],
        now(dependencies),
      );
      const batchFinishedAt = now(dependencies);
      await telemetry(
        store,
        dependencies,
        runId,
        "writing",
        "batch_acknowledged",
        "diagnostic",
        {
          batchNumber: index + 1,
          recordCount: batch.records.length,
          durationMs: elapsed(batchStartedAt, batchFinishedAt),
        },
      );
    }
    if (unchanged.length)
      await store.markUnchanged(
        runId,
        unchanged.map((record) => record.destinationId),
      );

    await checkpoint(store, runId, config.revision);
    await store.updateRun(runId, "reconciling", counts);
    await phaseStarted(store, dependencies, runId, "reconciling");
    await dependencies.verifyFields(
      requiredWrites.length ? requiredWrites : staged,
      () => checkpoint(store, runId, config.revision),
    );
    if (stale.length && shouldGuard(stale.length, manifest.length)) {
      const source = await sourceFingerprint(
        staged,
        quarantined,
        config.zendeskSubdomain,
      );
      const manifestRevision = await store.manifestRevision();
      const managed = await store.manifest();
      const managedFingerprint = await manifestFingerprint(managed);
      const destination = await destinationFingerprint(
        dependencies,
        stale,
        () => checkpoint(store, runId, config.revision),
      );
      const plan: DeletionPlan = {
        id: randomId(dependencies),
        runId,
        exactIds: stale,
        configRevision: config.revision,
        manifestRevision,
        manifestFingerprint: managedFingerprint,
        sourceFingerprint: source,
        destinationFingerprint: destination,
        fingerprint: await planFingerprint(
          stale,
          config.revision,
          manifestRevision,
          managedFingerprint,
          source,
          destination,
        ),
        state: "pending",
      };
      counts.withheldDeletions = stale.length;
      await store.saveDeletionPlan(plan);
      await store.updateRun(runId, "action_required", counts);
      await telemetry(
        store,
        dependencies,
        runId,
        "guarded",
        "deletion_guarded",
        "operator",
      );
      return { runId, state: "action_required", counts, deletionPlan: plan };
    }

    const failedDeletionIds = await deleteStale(
      store,
      runId,
      stale,
      config.revision,
      dependencies,
      counts,
    );
    await checkpoint(store, runId, config.revision);
    const preservedIds = quarantined
      .map(
        (record) =>
          previous.get(
            sourceIdentityKey(
              canonicalZendeskSourceIdentity(
                config.zendeskSubdomain,
                record.articleId,
                record.locale,
              ),
            ),
          )?.destinationId,
      )
      .filter((id): id is string => id !== undefined)
      .sort();
    const optionalIds = failedDeletionIds.sort();
    const verifyCheckpoint = () => checkpoint(store, runId, config.revision);
    if (preservedIds.length && !optionalIds.length)
      await dependencies.verify(staged, verifyCheckpoint, preservedIds);
    else if (preservedIds.length)
      await dependencies.verify(
        staged,
        verifyCheckpoint,
        preservedIds,
        optionalIds,
      );
    else if (optionalIds.length)
      await dependencies.verify(staged, verifyCheckpoint, [], optionalIds);
    else await dependencies.verify(staged, verifyCheckpoint);
    const terminal = counts.failedDeletions
      ? "completed_with_errors"
      : counts.quarantined
        ? "degraded"
        : "succeeded";
    const finishedAt = now(dependencies);
    await telemetry(
      store,
      dependencies,
      runId,
      terminal,
      `run_${terminal}`,
      terminal === "succeeded" ? "diagnostic" : "operator",
      { durationMs: elapsed(startedAt, finishedAt) },
    );
    await store.finish(runId, terminal);
    return { runId, state: terminal, counts };
  } catch (error) {
    if (error instanceof CanceledRun) {
      await store.updateRun(runId, "canceled", counts);
      await telemetry(
        store,
        dependencies,
        runId,
        "canceled",
        "run_canceled",
        "operator",
        { durationMs: elapsed(startedAt, now(dependencies)) },
      );
      await store.finish(runId, "canceled");
      return { runId, state: "canceled", counts };
    }
    await store.updateRun(runId, "failed", counts, safeFailureCode(error));
    await telemetry(
      store,
      dependencies,
      runId,
      "failed",
      "run_failed",
      "operator",
      { durationMs: elapsed(startedAt, now(dependencies)) },
    );
    await store.finish(runId, "failed");
    // Acknowledged upserts intentionally remain; the manifest records only
    // acknowledgements and a later stable-ID run converges safely.
    return { runId, state: "failed", counts };
  }
}

export async function reconcileArticle(
  store: ReconciliationStore,
  config: ReconciliationConfig,
  runId: string,
  articleId: string,
  locales: readonly string[],
  dependencies: ReconciliationDependencies,
): Promise<ReconciliationResult> {
  const counts = emptyCounts();
  const startedAt = now(dependencies);
  let outcome: "update" | "removal" | "noop" = "noop";
  try {
    await checkpoint(store, runId, config.revision);
    const manifest = await store.manifest();
    validateManifest(manifest, config.zendeskSubdomain);
    const previous = new Map(
      manifest.map((entry) => [sourceIdentityKey(entry.sourceIdentity), entry]),
    );
    const manifestByDestination = new Map(
      manifest.map((entry) => [
        entry.destinationId,
        sourceIdentityKey(entry.sourceIdentity),
      ]),
    );
    await store.updateRun(runId, "enumerating", counts);
    await phaseStarted(store, dependencies, runId, "enumerating");

    const fetched: StagedRecord[] = [];
    const quarantined: QuarantinedRecord[] = [];
    for (const locale of locales) {
      await checkpoint(store, runId, config.revision);
      const records = await dependencies.enumerate(
        locale,
        () => checkpoint(store, runId, config.revision),
        (record) => quarantined.push(record),
        articleId,
      );
      if (records.length > 1)
        throw new ContractError(
          "DUPLICATE_SOURCE_IDENTITY",
          "The article lookup returned duplicate records.",
        );
      if (records[0])
        fetched.push(
          ...(await adoptManifestDestinationIds(
            records,
            previous,
            manifestByDestination,
          )),
        );
    }
    const affected = new Set(
      locales.map((locale) =>
        sourceIdentityKey(
          canonicalZendeskSourceIdentity(
            config.zendeskSubdomain,
            articleId,
            locale,
          ),
        ),
      ),
    );
    const destinationIds = validateDestinationIds(
      await dependencies.destinationIds(() =>
        checkpoint(store, runId, config.revision),
      ),
      MAX_RECORDS[config.target],
    );
    const fetchedBySource = new Map(
      fetched.map((record) => [
        sourceIdentityKey(record.sourceIdentity),
        record,
      ]),
    );
    const quarantinedSources = new Set(
      quarantined.map((record) =>
        sourceIdentityKey(
          canonicalZendeskSourceIdentity(
            config.zendeskSubdomain,
            record.articleId,
            record.locale,
          ),
        ),
      ),
    );
    const writes = fetched.filter((record) => {
      const prior = previous.get(sourceIdentityKey(record.sourceIdentity));
      return (
        !prior ||
        prior.hash !== record.hash ||
        !destinationIds.has(record.destinationId)
      );
    });
    const unchanged = fetched.filter((record) => {
      const prior = previous.get(sourceIdentityKey(record.sourceIdentity));
      return (
        prior?.hash === record.hash && destinationIds.has(record.destinationId)
      );
    });
    const stale = manifest
      .filter((record) => {
        const key = sourceIdentityKey(record.sourceIdentity);
        return (
          affected.has(key) &&
          !fetchedBySource.has(key) &&
          !quarantinedSources.has(key)
        );
      })
      .map((record) => record.destinationId)
      .sort();
    Object.assign(counts, {
      source: fetched.length + quarantined.length,
      created: writes.filter(
        (record) => !previous.has(sourceIdentityKey(record.sourceIdentity)),
      ).length,
      changed: writes.filter((record) =>
        previous.has(sourceIdentityKey(record.sourceIdentity)),
      ).length,
      unchanged: unchanged.length,
      stale: stale.length,
      plannedDeletions: stale.length,
      warnings: fetched.filter((record) => record.warnings.length > 0).length,
      quarantined: quarantined.length,
    });
    if (quarantined.length)
      await telemetry(
        store,
        dependencies,
        runId,
        "enumerating",
        "incremental_article_quarantined",
        "operator",
        { recordCount: quarantined.length },
      );

    await store.updateRun(runId, "writing", counts);
    await phaseStarted(store, dependencies, runId, "writing");
    for (const [index, batch] of createUpsertBatches(writes).entries()) {
      await checkpoint(store, runId, config.revision);
      await dependencies.upsert(batch.records as readonly StagedRecord[]);
      await store.acknowledge(
        runId,
        batch.records as readonly StagedRecord[],
        now(dependencies),
      );
      await telemetry(
        store,
        dependencies,
        runId,
        "writing",
        "batch_acknowledged",
        "diagnostic",
        { batchNumber: index + 1, recordCount: batch.records.length },
      );
    }
    if (unchanged.length)
      await store.markUnchanged(
        runId,
        unchanged.map((record) => record.destinationId),
      );

    await checkpoint(store, runId, config.revision);
    await store.updateRun(runId, "reconciling", counts);
    await phaseStarted(store, dependencies, runId, "reconciling");
    if (fetched.length)
      await dependencies.verifyFields(fetched, () =>
        checkpoint(store, runId, config.revision),
      );
    for (const id of stale) {
      await checkpoint(store, runId, config.revision);
      try {
        if (!destinationIds.has(id) && dependencies.destinationDocument) {
          const actual = await dependencies.destinationDocument(id);
          if (!actual) {
            await store.removeManifest([id]);
            counts.successfulDeletions += 1;
            continue;
          }
          if (actual.connector_key_s !== config.connectorKey) {
            counts.failedDeletions += 1;
            await telemetry(
              store,
              dependencies,
              runId,
              "deleting",
              "ownership_mismatch",
              "operator",
              { recordCount: 1 },
            );
            continue;
          }
        } else if (!destinationIds.has(id)) {
          counts.failedDeletions += 1;
          await telemetry(
            store,
            dependencies,
            runId,
            "deleting",
            "ownership_unverified",
            "operator",
            { recordCount: 1 },
          );
          continue;
        }
        await dependencies.deleteExactIds(
          [id],
          isGeneratedDestinationId(id) ? undefined : new Set([id]),
        );
        await store.removeManifest([id]);
        counts.successfulDeletions += 1;
      } catch {
        counts.failedDeletions += 1;
        await telemetry(
          store,
          dependencies,
          runId,
          "deleting",
          "batch_failed",
          "operator",
          { recordCount: 1 },
        );
      }
    }
    if (writes.length) outcome = "update";
    else if (stale.length) outcome = "removal";
    const terminal = counts.failedDeletions
      ? "completed_with_errors"
      : counts.quarantined
        ? "degraded"
        : "succeeded";
    await telemetry(
      store,
      dependencies,
      runId,
      terminal,
      `incremental_${outcome}_${terminal}`,
      terminal === "succeeded" ? "diagnostic" : "operator",
      { durationMs: elapsed(startedAt, now(dependencies)) },
    );
    await store.finish(runId, terminal);
    return { runId, state: terminal, counts };
  } catch (error) {
    await store.updateRun(runId, "failed", counts, safeFailureCode(error));
    await telemetry(
      store,
      dependencies,
      runId,
      "failed",
      "incremental_failed",
      "operator",
      { durationMs: elapsed(startedAt, now(dependencies)) },
    );
    await store.finish(runId, "failed");
    return { runId, state: "failed", counts };
  }
}

async function deleteStale(
  store: ReconciliationStore,
  runId: string,
  ids: readonly string[],
  configRevision: number,
  dependencies: ReconciliationDependencies,
  counts: RunCounts,
): Promise<string[]> {
  if (!ids.length) return [];
  const failed: string[] = [];
  await store.updateRun(runId, "deleting", counts);
  await phaseStarted(store, dependencies, runId, "deleting");
  for (let index = 0; index < ids.length; index += MAX_DELETE_BATCH) {
    await checkpoint(store, runId, configRevision);
    const batch = ids.slice(index, index + MAX_DELETE_BATCH);
    const batchStartedAt = now(dependencies);
    const trusted = batch.some((id) => !isGeneratedDestinationId(id))
      ? new Set(batch)
      : undefined;
    try {
      if (trusted) await dependencies.deleteExactIds(batch, trusted);
      else await dependencies.deleteExactIds(batch);
    } catch {
      failed.push(...batch);
      counts.failedDeletions += batch.length;
      await telemetry(
        store,
        dependencies,
        runId,
        "deleting",
        "batch_failed",
        "operator",
        {
          batchNumber: index / MAX_DELETE_BATCH + 1,
          recordCount: batch.length,
          durationMs: elapsed(batchStartedAt, now(dependencies)),
        },
      );
      await store.updateRun(runId, "deleting", counts);
      continue;
    }
    await store.removeManifest(batch);
    counts.successfulDeletions += batch.length;
    await telemetry(
      store,
      dependencies,
      runId,
      "deleting",
      "batch_acknowledged",
      "diagnostic",
      {
        batchNumber: index / MAX_DELETE_BATCH + 1,
        recordCount: batch.length,
        durationMs: elapsed(batchStartedAt, now(dependencies)),
      },
    );
    await store.updateRun(runId, "deleting", counts);
  }
  return failed;
}

export async function confirmDeletion(
  store: ReconciliationStore,
  config: ReconciliationConfig,
  planId: string,
  suppliedFingerprint: string,
  dependencies: ReconciliationDependencies,
): Promise<ReconciliationResult> {
  const startedAt = now(dependencies);
  const plan = await store.deletionPlan(planId);
  if (
    !plan ||
    plan.state !== "pending" ||
    plan.fingerprint !== suppliedFingerprint
  )
    throw new ContractError(
      "DELETION_PLAN_MISMATCH",
      "The exact deletion plan confirmation did not match.",
    );
  const run = await store.run(plan.runId);
  const staged = await store.staged(plan.runId);
  const quarantined = await store.quarantined(plan.runId);
  const currentSource = await sourceFingerprint(
    staged,
    quarantined,
    config.zendeskSubdomain,
  );
  const currentManifest = await store.manifest();
  const currentManifestFingerprint = await manifestFingerprint(currentManifest);
  const currentDestinationFingerprint = await destinationFingerprint(
    dependencies,
    plan.exactIds,
    async () => undefined,
  );
  if (
    !run ||
    !["guarded", "action_required"].includes(run.state) ||
    config.revision !== plan.configRevision ||
    (await store.configurationRevision()) !== plan.configRevision ||
    (await store.manifestRevision()) !== plan.manifestRevision ||
    currentManifestFingerprint !== plan.manifestFingerprint ||
    currentSource !== plan.sourceFingerprint ||
    currentDestinationFingerprint !== plan.destinationFingerprint
  ) {
    await store.updateDeletionPlan(plan.id, "invalidated");
    if (run) {
      await store.updateRun(
        plan.runId,
        "failed",
        run.counts,
        "DELETION_PLAN_STALE",
      );
      await store.finish(plan.runId, "failed");
    }
    throw new ContractError(
      "DELETION_PLAN_STALE",
      "The deletion plan changed and a new full sync is required.",
    );
  }
  await checkpoint(store, plan.runId, config.revision);
  await store.updateDeletionPlan(plan.id, "confirmed");
  try {
    const failedDeletionIds = await deleteStale(
      store,
      plan.runId,
      plan.exactIds,
      config.revision,
      dependencies,
      run.counts,
    );
    await checkpoint(store, plan.runId, config.revision);
    const manifestBySource = new Map(
      (await store.manifest()).map((record) => [
        sourceIdentityKey(record.sourceIdentity),
        record.destinationId,
      ]),
    );
    const preservedIds = quarantined
      .map((record) =>
        manifestBySource.get(
          sourceIdentityKey(
            canonicalZendeskSourceIdentity(
              config.zendeskSubdomain,
              record.articleId,
              record.locale,
            ),
          ),
        ),
      )
      .filter((id): id is string => id !== undefined)
      .sort();
    const optionalIds = failedDeletionIds.sort();
    const verifyCheckpoint = () =>
      checkpoint(store, plan.runId, config.revision);
    if (preservedIds.length && !optionalIds.length)
      await dependencies.verify(staged, verifyCheckpoint, preservedIds);
    else if (preservedIds.length)
      await dependencies.verify(
        staged,
        verifyCheckpoint,
        preservedIds,
        optionalIds,
      );
    else if (optionalIds.length)
      await dependencies.verify(staged, verifyCheckpoint, [], optionalIds);
    else await dependencies.verify(staged, verifyCheckpoint);
    await store.updateDeletionPlan(plan.id, "applied");
    const terminal = run.counts.failedDeletions
      ? "completed_with_errors"
      : run.counts.quarantined
        ? "degraded"
        : "succeeded";
    await telemetry(
      store,
      dependencies,
      plan.runId,
      terminal,
      `run_${terminal}`,
      terminal === "succeeded" ? "diagnostic" : "operator",
      { durationMs: elapsed(startedAt, now(dependencies)) },
    );
    await store.finish(plan.runId, terminal);
    return { runId: plan.runId, state: terminal, counts: run.counts };
  } catch (error) {
    if (error instanceof CanceledRun) {
      await telemetry(
        store,
        dependencies,
        plan.runId,
        "canceled",
        "run_canceled",
        "operator",
        { durationMs: elapsed(startedAt, now(dependencies)) },
      );
      await store.finish(plan.runId, "canceled");
      return { runId: plan.runId, state: "canceled", counts: run.counts };
    }
    await store.updateRun(
      plan.runId,
      "failed",
      run.counts,
      safeFailureCode(error),
    );
    await telemetry(
      store,
      dependencies,
      plan.runId,
      "failed",
      "run_failed",
      "operator",
      { durationMs: elapsed(startedAt, now(dependencies)) },
    );
    await store.finish(plan.runId, "failed");
    return { runId: plan.runId, state: "failed", counts: run.counts };
  }
}
