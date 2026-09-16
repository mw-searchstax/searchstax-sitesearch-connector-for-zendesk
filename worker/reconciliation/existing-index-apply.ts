import {
  canonicalJson,
  prepareRecordForDestinationId,
  type Json,
} from "../contracts/record.ts";
import { searchStaxFieldMatches } from "../contracts/searchstax.ts";
import { ContractError } from "../contracts/shared.ts";
import {
  existingIndexProof,
  type ExistingIndexCandidate,
  type ExistingIndexDryRunAction,
  type ExistingIndexDryRunDependencies,
  type ExistingIndexProof,
  type ExistingIndexSourceEntry,
} from "./existing-index-dry-run.ts";
import {
  sourceIdentityKey,
  type ManifestRecord,
  type ReconciliationConfig,
  type StagedRecord,
} from "./model.ts";

export interface ExistingIndexApplyDependencies extends ExistingIndexDryRunDependencies {
  upsert(records: readonly StagedRecord[]): Promise<void>;
  deleteExactIds(
    ids: readonly string[],
    approvedCandidateIds?: ReadonlySet<string>,
  ): Promise<void>;
  acknowledge(records: readonly StagedRecord[]): Promise<void>;
  manifest(): Promise<readonly ManifestRecord[]>;
  manifestRevision(): Promise<number>;
  destinationDocument?(id: string): Promise<Record<string, Json> | null>;
  configurationRevision?(): Promise<number>;
  finalVerificationAttempts?: number;
  finalVerificationDelayMs?: number;
  sleep?(milliseconds: number): Promise<void>;
  now?: () => string;
}

export interface ExistingIndexApplyCounts {
  managed: number;
  adopted: number;
  created: number;
  consolidated: number;
  redundantDeleted: number;
  failedWrites: number;
  failedRedundantDeletes: number;
  unresolvedResiduals: number;
  ambiguousUnmatched: number;
}

export interface ExistingIndexApplyResult {
  status: "applied" | "rejected" | "partial" | "failed";
  reviewedFingerprint: string;
  recomputedFingerprint: string;
  counts: ExistingIndexApplyCounts;
  unresolvedResiduals: readonly string[];
  finalVerification: "passed" | "failed" | "not_run";
  reasonCode?: string;
  message?: string;
}

function emptyCounts(ambiguousUnmatched = 0): ExistingIndexApplyCounts {
  return {
    managed: 0,
    adopted: 0,
    created: 0,
    consolidated: 0,
    redundantDeleted: 0,
    failedWrites: 0,
    failedRedundantDeletes: 0,
    unresolvedResiduals: 0,
    ambiguousUnmatched,
  };
}

function code(error: unknown): string {
  return error instanceof ContractError ? error.code : "APPLY_MUTATION_FAILED";
}

function expectedMatches(
  actual: Record<string, Json> | undefined,
  expected: Record<string, Json>,
): boolean {
  return (
    !!actual &&
    Object.entries(expected).every(([field, value]) =>
      searchStaxFieldMatches(field, actual[field], value),
    )
  );
}

function candidateMap(
  candidates: readonly ExistingIndexCandidate[],
): Map<string, ExistingIndexCandidate> {
  return new Map(candidates.map((candidate) => [candidate.id, candidate]));
}

function actionMap(
  actions: readonly ExistingIndexDryRunAction[],
): Map<string, ExistingIndexDryRunAction> {
  return new Map(
    actions.flatMap((action) =>
      action.sourceIdentity
        ? [[sourceIdentityKey(action.sourceIdentity), action] as const]
        : [],
    ),
  );
}

async function destinationRecord(
  source: ExistingIndexSourceEntry,
  destinationId: string,
): Promise<StagedRecord> {
  const prepared = await prepareRecordForDestinationId(
    source.record,
    destinationId,
  );
  return {
    ...source.record,
    ...prepared,
    id: destinationId,
    destinationId,
  };
}

function needsUpsert(
  candidate: ExistingIndexCandidate | undefined,
  record: StagedRecord,
): boolean {
  return !candidate || !expectedMatches(candidate.document, record.document);
}

const FINAL_VERIFICATION_ATTEMPTS = 41;
const FINAL_VERIFICATION_DELAY_MS = 15_000;

function baseResult(
  reviewedFingerprint: string,
  proof: ExistingIndexProof,
): ExistingIndexApplyResult {
  return {
    status: "rejected",
    reviewedFingerprint,
    recomputedFingerprint: proof.result.fingerprint,
    counts: emptyCounts(proof.result.counts.ambiguousUnmatched),
    unresolvedResiduals: [],
    finalVerification: "not_run",
  };
}

async function verifyFinal(
  config: ReconciliationConfig,
  initial: ExistingIndexProof,
  expectedRecords: ReadonlyMap<string, StagedRecord>,
  residuals: ReadonlySet<string>,
  dependencies: ExistingIndexApplyDependencies,
): Promise<{ passed: boolean; residuals: string[]; reasonCode?: string }> {
  const attempts = Math.max(
    1,
    dependencies.finalVerificationAttempts ?? FINAL_VERIFICATION_ATTEMPTS,
  );
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await verifyFinalAttempt(
      config,
      initial,
      expectedRecords,
      residuals,
      dependencies,
    );
    if (!result.retryable) return result;
    if (attempt === attempts - 1)
      return {
        passed: false,
        residuals: [],
        reasonCode: "FINAL_VERIFICATION_VISIBILITY_TIMEOUT",
      };
    const delay =
      dependencies.finalVerificationDelayMs ?? FINAL_VERIFICATION_DELAY_MS;
    if (delay > 0)
      await (
        dependencies.sleep ??
        ((milliseconds: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
      )(delay);
  }
  return { passed: false, residuals: [] };
}

async function verifyFinalAttempt(
  config: ReconciliationConfig,
  initial: ExistingIndexProof,
  expectedRecords: ReadonlyMap<string, StagedRecord>,
  residuals: ReadonlySet<string>,
  dependencies: ExistingIndexApplyDependencies,
): Promise<{ passed: boolean; residuals: string[]; retryable?: boolean }> {
  if (
    dependencies.configurationRevision &&
    (await dependencies.configurationRevision()) !== config.revision
  )
    return { passed: false, residuals: [] };
  const finalManifest = await dependencies.manifest();
  const finalProof = await existingIndexProof(
    config,
    finalManifest,
    await dependencies.manifestRevision(),
    dependencies,
  );
  const initialSources = new Map(
    initial.sources.map((source) => [source.key, source.record.hash]),
  );
  if (
    finalProof.sources.length !== initial.sources.length ||
    finalProof.sources.some(
      (source) => initialSources.get(source.key) !== source.record.hash,
    ) ||
    finalProof.quarantined.join("\u0000") !== initial.quarantined.join("\u0000")
  )
    return { passed: false, residuals: [] };

  const initialCandidates = candidateMap(initial.candidates);
  const finalCandidates = candidateMap(finalProof.candidates);
  for (const action of initial.result.actions.filter(
    (item) => item.classification === "ambiguous/unmatched",
  )) {
    for (const id of action.candidateDestinationIds) {
      if (
        canonicalJson(initialCandidates.get(id)?.document) !==
        canonicalJson(finalCandidates.get(id)?.document)
      )
        return { passed: false, residuals: [] };
    }
  }

  const finalActions = actionMap(finalProof.result.actions);
  const manifestBySource = new Map(
    finalManifest.map((record) => [
      sourceIdentityKey(record.sourceIdentity),
      record,
    ]),
  );
  const actualResiduals = new Set<string>();
  for (const [key, expected] of expectedRecords) {
    const action = initial.result.actions.find(
      (item) =>
        item.sourceIdentity && sourceIdentityKey(item.sourceIdentity) === key,
    );
    const destinationId = action?.proposedDestinationId;
    const managed = manifestBySource.get(key);
    const finalAction = finalActions.get(key);
    if (
      !action ||
      !destinationId ||
      !managed ||
      managed.destinationId !== destinationId ||
      !finalAction ||
      !["managed", "consolidate"].includes(finalAction.classification)
    )
      return { passed: false, residuals: [] };
    const actual = finalAction.redundantDestinationIds;
    for (const id of actual) {
      if (!residuals.has(id))
        return { passed: false, residuals: [], retryable: true };
      actualResiduals.add(id);
    }
    if (dependencies.destinationDocument) {
      const document = await dependencies.destinationDocument(destinationId);
      if (!expectedMatches(document ?? undefined, expected.document))
        return { passed: false, residuals: [] };
    } else if (
      !expectedMatches(finalCandidates.get(destinationId)?.document, {
        id: destinationId,
        url_s: expected.document.url_s,
      })
    ) {
      return { passed: false, residuals: [] };
    }
  }
  return { passed: true, residuals: [...actualResiduals].sort() };
}

export async function existingIndexApply(
  config: ReconciliationConfig,
  manifest: readonly ManifestRecord[],
  manifestRevision: number,
  reviewedFingerprint: string,
  legacyIngestionPaused: boolean,
  dependencies: ExistingIndexApplyDependencies,
): Promise<ExistingIndexApplyResult> {
  if (!legacyIngestionPaused) {
    return {
      status: "rejected",
      reviewedFingerprint,
      recomputedFingerprint: "",
      counts: emptyCounts(),
      unresolvedResiduals: [],
      finalVerification: "not_run",
      reasonCode: "LEGACY_INGESTION_NOT_PAUSED",
      message:
        "Confirm that legacy crawler or ingestion processes are paused or disabled before apply.",
    };
  }
  const initial = await existingIndexProof(
    config,
    manifest,
    manifestRevision,
    dependencies,
  );
  if (initial.result.fingerprint !== reviewedFingerprint) {
    return {
      ...baseResult(reviewedFingerprint, initial),
      reasonCode: "REVIEWED_PROOF_CHANGED",
      message: "The reviewed proof changed. Run a new existing-index dry run.",
    };
  }
  const result: ExistingIndexApplyResult = {
    status: "failed",
    reviewedFingerprint,
    recomputedFingerprint: initial.result.fingerprint,
    counts: emptyCounts(initial.result.counts.ambiguousUnmatched),
    unresolvedResiduals: [],
    finalVerification: "not_run",
  };
  const candidates = candidateMap(initial.candidates);
  const sources = new Map(
    initial.sources.map((source) => [source.key, source]),
  );
  const managedBySource = new Map(
    manifest.map((record) => [
      sourceIdentityKey(record.sourceIdentity),
      record,
    ]),
  );
  const expectedRecords = new Map<string, StagedRecord>();
  const residuals = new Set<string>();
  let mutationAcknowledged = false;

  for (const action of initial.result.actions) {
    if (action.classification === "ambiguous/unmatched") continue;
    const key = action.sourceIdentity
      ? sourceIdentityKey(action.sourceIdentity)
      : undefined;
    const source = key ? sources.get(key) : undefined;
    const destinationId = action.proposedDestinationId;
    if (!key || !source || !destinationId) {
      result.counts.failedWrites += 1;
      continue;
    }
    if (
      dependencies.configurationRevision &&
      (await dependencies.configurationRevision()) !== config.revision
    ) {
      result.reasonCode = "CONFIGURATION_REVISION_CHANGED";
      break;
    }
    let record: StagedRecord;
    try {
      record = await destinationRecord(source, destinationId);
      expectedRecords.set(key, record);
    } catch (error) {
      result.counts.failedWrites += 1;
      result.reasonCode ??= code(error);
      continue;
    }

    try {
      const currentDocument = dependencies.destinationDocument
        ? await dependencies.destinationDocument(destinationId)
        : candidates.get(destinationId)?.document;
      const current = currentDocument
        ? { id: destinationId, document: currentDocument }
        : undefined;
      if (
        action.classification === "managed" &&
        !needsUpsert(current, record)
      ) {
        const existing = managedBySource.get(key);
        if (
          !existing ||
          existing.destinationId !== destinationId ||
          existing.hash !== record.hash
        )
          await dependencies.acknowledge([record]);
      } else {
        await dependencies.upsert([record]);
        mutationAcknowledged = true;
        await dependencies.acknowledge([record]);
      }
    } catch (error) {
      result.counts.failedWrites += 1;
      result.reasonCode ??= code(error);
      continue;
    }

    if (action.classification === "managed") result.counts.managed += 1;
    if (action.classification === "adopt") result.counts.adopted += 1;
    if (action.classification === "create") result.counts.created += 1;
    if (action.classification === "consolidate") {
      result.counts.consolidated += 1;
      for (const id of action.redundantDestinationIds) {
        try {
          await dependencies.deleteExactIds([id], new Set([id]));
          mutationAcknowledged = true;
          result.counts.redundantDeleted += 1;
        } catch (error) {
          result.counts.failedRedundantDeletes += 1;
          residuals.add(id);
          result.reasonCode ??= code(error);
        }
      }
    }
  }

  result.unresolvedResiduals = [...residuals].sort();
  result.counts.unresolvedResiduals = result.unresolvedResiduals.length;
  if (result.reasonCode === "CONFIGURATION_REVISION_CHANGED") {
    result.status = mutationAcknowledged ? "partial" : "failed";
    result.finalVerification = "failed";
    return result;
  }
  try {
    const verification = await verifyFinal(
      config,
      initial,
      expectedRecords,
      residuals,
      dependencies,
    );
    result.unresolvedResiduals = verification.residuals;
    result.counts.unresolvedResiduals = verification.residuals.length;
    result.finalVerification = verification.passed ? "passed" : "failed";
    if (!verification.passed) {
      result.status = mutationAcknowledged ? "partial" : "failed";
      result.reasonCode ??=
        verification.reasonCode ?? "FINAL_VERIFICATION_FAILED";
      return result;
    }
  } catch (error) {
    result.finalVerification = "failed";
    result.reasonCode ??= code(error);
    result.status = mutationAcknowledged ? "partial" : "failed";
    return result;
  }
  if (result.counts.failedWrites || result.counts.failedRedundantDeletes) {
    result.status = "partial";
    return result;
  }
  result.status = "applied";
  return result;
}
