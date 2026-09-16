import {
  canonicalJson,
  normalizeLocale,
  type Json,
} from "../contracts/record.ts";
import {
  SEARCHSTAX_CANDIDATE_URL_FIELDS,
  isSafeDestinationId,
  type SearchStaxCandidate,
  type SearchStaxCandidateDiscovery,
  type SearchStaxCandidateFieldAvailability,
  type SearchStaxCandidateUrlField,
} from "../contracts/searchstax.ts";
import { ContractError } from "../contracts/shared.ts";
import {
  canonicalZendeskSourceIdentity,
  sourceIdentityKey,
  type ManifestRecord,
  type ReconciliationConfig,
  type StagedRecord,
  type ZendeskSourceIdentity,
} from "./model.ts";

export const EXISTING_INDEX_URL_FIELDS = SEARCHSTAX_CANDIDATE_URL_FIELDS;
export type ExistingIndexUrlField = SearchStaxCandidateUrlField;
export type ExistingIndexClassification =
  "managed" | "adopt" | "consolidate" | "create" | "ambiguous/unmatched";

export type ExistingIndexCandidate = SearchStaxCandidate;
export type ExistingIndexCandidateDiscovery = SearchStaxCandidateDiscovery;

export interface ExistingIndexDryRunDependencies {
  enumerate(
    locale: string,
    checkpoint: () => Promise<void>,
    quarantine: (record: {
      articleId: string;
      locale: string;
      publicTitle: string;
      publicUrl: string;
      reasonCode: string;
    }) => void,
  ): Promise<readonly StagedRecord[]>;
  discoverCandidates(
    checkpoint: () => Promise<void>,
    sourceUrls?: readonly string[],
  ): Promise<ExistingIndexCandidateDiscovery>;
}

export interface ExistingIndexDryRunAction {
  classification: ExistingIndexClassification;
  sourceIdentity?: ZendeskSourceIdentity;
  locale?: string;
  candidateDestinationIds: readonly string[];
  proposedDestinationId?: string;
  redundantDestinationIds: readonly string[];
  reasonCode?: string;
}

export interface ExistingIndexDryRunResult {
  readOnly: true;
  fingerprint: string;
  fieldAvailability: SearchStaxCandidateFieldAvailability;
  counts: {
    sourceIdentities: number;
    candidates: number;
    managed: number;
    adopt: number;
    consolidate: number;
    create: number;
    ambiguousUnmatched: number;
  };
  actions: readonly ExistingIndexDryRunAction[];
}

export interface ExistingIndexSourceEntry {
  record: StagedRecord;
  identity: ZendeskSourceIdentity;
  key: string;
  url: string | null;
}

export interface ExistingIndexCandidateResolution {
  identity?: ZendeskSourceIdentity;
  key?: string;
  urls: readonly string[];
  reasonCode?: string;
}

export interface ExistingIndexProof {
  result: ExistingIndexDryRunResult;
  sources: readonly ExistingIndexSourceEntry[];
  candidates: readonly ExistingIndexCandidate[];
  fieldAvailability: SearchStaxCandidateFieldAvailability;
  resolutions: ReadonlyMap<string, ExistingIndexCandidateResolution>;
  quarantined: readonly string[];
}

function sha256(value: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    );
}

function values(value: Json | undefined): {
  values: string[];
  invalid: boolean;
} {
  if (value === undefined || value === null || value === "")
    return { values: [], invalid: false };
  if (typeof value === "string") return { values: [value], invalid: false };
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return { values: value as string[], invalid: false };
  return { values: [], invalid: true };
}

export function parseZendeskArticleUrl(
  value: string,
  configuredSubdomain: string,
): ZendeskSourceIdentity | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const subdomain = configuredSubdomain.trim().toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname.toLowerCase() !== `${subdomain}.zendesk.com`
  )
    return null;
  const parts = url.pathname.split("/");
  if (parts.length !== 5 || parts[1] !== "hc" || parts[3] !== "articles")
    return null;
  const article = parts[4] ?? "";
  const match = /^(\d+)(?:-.+)?$/u.exec(article);
  if (!match) return null;
  try {
    return canonicalZendeskSourceIdentity(
      subdomain,
      match[1]!,
      normalizeLocale(parts[2]!),
    );
  } catch {
    return null;
  }
}

function resolveCandidate(
  candidate: ExistingIndexCandidate,
  subdomain: string,
  sourceUrlEvidence: ReadonlyMap<string, ZendeskSourceIdentity | null>,
): ExistingIndexCandidateResolution {
  const parsed = new Map<string, ZendeskSourceIdentity>();
  const urls: string[] = [];
  let invalid = false;
  for (const field of EXISTING_INDEX_URL_FIELDS) {
    const result = values(candidate.document[field]);
    invalid ||= result.invalid;
    for (const value of result.values) {
      urls.push(value);
      const identity = parseZendeskArticleUrl(value, subdomain);
      if (identity) parsed.set(sourceIdentityKey(identity), identity);
      else {
        let normalized: string;
        try {
          const url = new URL(value);
          if (url.protocol !== "https:" || url.username || url.password)
            throw new Error();
          url.hash = "";
          normalized = url.toString();
        } catch {
          invalid = true;
          continue;
        }
        const evidenced = sourceUrlEvidence.get(normalized);
        if (evidenced === undefined || evidenced === null) invalid = true;
        else parsed.set(sourceIdentityKey(evidenced), evidenced);
      }
    }
  }
  if (invalid) return { urls, reasonCode: "UNTRUSTED_URL_EVIDENCE" };
  if (!parsed.size)
    return { urls, reasonCode: "NO_USABLE_ZENDESK_ARTICLE_URL" };
  if (parsed.size > 1)
    return { urls, reasonCode: "CONFLICTING_SOURCE_IDENTITIES" };
  const identity = parsed.values().next().value as ZendeskSourceIdentity;
  return { identity, key: sourceIdentityKey(identity), urls };
}

function currentUrl(record: StagedRecord): string | null {
  const value = record.document.url_s;
  return typeof value === "string" ? value : null;
}

function generatedId(
  config: ReconciliationConfig,
  identity: ZendeskSourceIdentity,
) {
  return `zdg_${config.connectorKey}_${identity.articleId}_${identity.locale}`;
}

function actionOrder(
  left: ExistingIndexDryRunAction,
  right: ExistingIndexDryRunAction,
) {
  return (
    (left.sourceIdentity
      ? sourceIdentityKey(left.sourceIdentity)
      : "~"
    ).localeCompare(
      right.sourceIdentity ? sourceIdentityKey(right.sourceIdentity) : "~",
    ) ||
    (left.candidateDestinationIds[0] ?? "").localeCompare(
      right.candidateDestinationIds[0] ?? "",
    )
  );
}

function chooseSurvivor(
  config: ReconciliationConfig,
  source: ExistingIndexSourceEntry,
  ids: readonly string[],
  candidates: ReadonlyMap<string, ExistingIndexCandidateResolution>,
  managedId?: string,
): string {
  if (managedId && ids.includes(managedId)) return managedId;
  const generated = generatedId(config, source.identity);
  if (ids.includes(generated)) return generated;
  const exact = ids.filter((id) =>
    (candidates.get(id)?.urls ?? []).includes(source.url ?? "\u0000"),
  );
  return [...(exact.length ? exact : ids)].sort((left, right) =>
    left.localeCompare(right),
  )[0]!;
}

export async function existingIndexProof(
  config: ReconciliationConfig,
  manifest: readonly ManifestRecord[],
  manifestRevision: number,
  dependencies: ExistingIndexDryRunDependencies,
): Promise<ExistingIndexProof> {
  const sources = new Map<string, ExistingIndexSourceEntry>();
  const quarantined = new Set<string>();
  for (const locale of config.locales) {
    for (const record of await dependencies.enumerate(
      locale,
      async () => undefined,
      (item) => {
        try {
          quarantined.add(
            sourceIdentityKey(
              canonicalZendeskSourceIdentity(
                config.zendeskSubdomain,
                item.articleId,
                item.locale,
              ),
            ),
          );
        } catch {
          // The source contract owns malformed quarantine identity handling.
        }
      },
    )) {
      const identity = canonicalZendeskSourceIdentity(
        config.zendeskSubdomain,
        record.articleId,
        record.locale,
      );
      const key = sourceIdentityKey(identity);
      if (sourceIdentityKey(record.sourceIdentity) !== key)
        throw new ContractError(
          "INVALID_RECORD",
          "The source inventory contained inconsistent source identity.",
        );
      if (sources.has(key) || quarantined.has(key))
        throw new ContractError(
          "DUPLICATE_SOURCE_IDENTITY",
          "The source inventory was not unique.",
        );
      sources.set(key, { record, identity, key, url: currentUrl(record) });
    }
  }
  const sourceLimit = config.target === "hosted" ? 500 : 5_000;
  if (sources.size + quarantined.size > sourceLimit)
    throw new ContractError(
      "CORPUS_LIMIT_EXCEEDED",
      "The complete source exceeded the configured execution target.",
    );

  const discovery = await dependencies.discoverCandidates(
    async () => undefined,
    [...sources.values()]
      .map((source) => source.url)
      .filter((url): url is string => url !== null),
  );
  const candidates = new Map<string, ExistingIndexCandidate>();
  for (const candidate of discovery.candidates) {
    if (
      !isSafeDestinationId(candidate.id) ||
      candidate.document.id !== candidate.id
    )
      throw new ContractError(
        "INVALID_RESPONSE",
        "The candidate inventory contained an invalid destination ID.",
      );
    const prior = candidates.get(candidate.id);
    if (
      prior &&
      canonicalJson(prior.document) !== canonicalJson(candidate.document)
    )
      throw new ContractError(
        "INVALID_RESPONSE",
        "The candidate inventory contained conflicting duplicate IDs.",
      );
    candidates.set(candidate.id, candidate);
  }

  const resolutions = new Map<string, ExistingIndexCandidateResolution>();
  const bySource = new Map<string, string[]>();
  const actions: ExistingIndexDryRunAction[] = [];
  const sourceUrlEvidence = new Map<string, ZendeskSourceIdentity | null>();
  for (const source of sources.values()) {
    if (!source.url) continue;
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:" || url.username || url.password) continue;
      url.hash = "";
      const key = url.toString();
      const prior = sourceUrlEvidence.get(key);
      sourceUrlEvidence.set(key, prior === undefined ? source.identity : null);
    } catch {
      // Source URL validation is owned by the source contract.
    }
  }
  for (const candidate of [...candidates.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const resolution = resolveCandidate(
      candidate,
      config.zendeskSubdomain,
      sourceUrlEvidence,
    );
    resolutions.set(candidate.id, resolution);
    if (
      !resolution.key ||
      resolution.reasonCode ||
      !sources.has(resolution.key) ||
      quarantined.has(resolution.key)
    ) {
      actions.push({
        classification: "ambiguous/unmatched",
        candidateDestinationIds: [candidate.id],
        redundantDestinationIds: [],
        ...(resolution.reasonCode
          ? { reasonCode: resolution.reasonCode }
          : { reasonCode: "SOURCE_NOT_CURRENT" }),
      });
      continue;
    }
    const ids = bySource.get(resolution.key) ?? [];
    ids.push(candidate.id);
    bySource.set(resolution.key, ids);
  }

  const managed = new Map<string, ManifestRecord>();
  const managedDestinationIds = new Map<string, string>();
  for (const record of manifest) {
    if (!isSafeDestinationId(record.destinationId))
      throw new ContractError(
        "INVALID_RESPONSE",
        "Managed state contained an invalid destination ID.",
      );
    const identity = canonicalZendeskSourceIdentity(
      config.zendeskSubdomain,
      record.sourceIdentity.articleId,
      record.sourceIdentity.locale,
    );
    const key = sourceIdentityKey(record.sourceIdentity);
    if (sourceIdentityKey(identity) !== key)
      throw new ContractError(
        "INVALID_RESPONSE",
        "Managed state contained inconsistent source identity.",
      );
    if (managed.has(key))
      throw new ContractError(
        "INVALID_RESPONSE",
        "Managed source identity was duplicated.",
      );
    const previousSource = managedDestinationIds.get(record.destinationId);
    if (previousSource && previousSource !== key)
      throw new ContractError(
        "INVALID_RESPONSE",
        "Managed destination identity was claimed by multiple sources.",
      );
    managedDestinationIds.set(record.destinationId, key);
    managed.set(key, record);
  }
  for (const [candidateId, resolution] of resolutions) {
    const owner = managedDestinationIds.get(candidateId);
    if (owner && resolution.key && owner !== resolution.key)
      throw new ContractError(
        "INVALID_RESPONSE",
        "Managed destination identity conflicted with candidate source identity.",
      );
  }
  for (const source of [...sources.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  )) {
    const candidatesForSource = [...(bySource.get(source.key) ?? [])].sort(
      (left, right) => left.localeCompare(right),
    );
    const owned = managed.get(source.key);
    const allIds = [
      ...new Set([
        ...(owned ? [owned.destinationId] : []),
        ...candidatesForSource,
      ]),
    ].sort();
    if (
      owned &&
      candidatesForSource.every((id) => id === owned.destinationId)
    ) {
      actions.push({
        classification: "managed",
        sourceIdentity: source.identity,
        locale: source.identity.locale,
        candidateDestinationIds: allIds,
        proposedDestinationId: owned.destinationId,
        redundantDestinationIds: [],
      });
    } else if (owned || candidatesForSource.length > 1) {
      const survivor = chooseSurvivor(
        config,
        source,
        allIds,
        resolutions,
        owned?.destinationId,
      );
      actions.push({
        classification: "consolidate",
        sourceIdentity: source.identity,
        locale: source.identity.locale,
        candidateDestinationIds: allIds,
        proposedDestinationId: survivor,
        redundantDestinationIds: allIds.filter((id) => id !== survivor),
      });
    } else if (candidatesForSource.length === 1) {
      actions.push({
        classification: "adopt",
        sourceIdentity: source.identity,
        locale: source.identity.locale,
        candidateDestinationIds: candidatesForSource,
        proposedDestinationId: candidatesForSource[0],
        redundantDestinationIds: [],
      });
    } else {
      const proposedDestinationId = generatedId(config, source.identity);
      if (candidates.has(proposedDestinationId)) {
        actions.push({
          classification: "ambiguous/unmatched",
          sourceIdentity: source.identity,
          locale: source.identity.locale,
          candidateDestinationIds: [proposedDestinationId],
          redundantDestinationIds: [],
          reasonCode: "DESTINATION_ID_CONFLICT",
        });
        continue;
      }
      actions.push({
        classification: "create",
        sourceIdentity: source.identity,
        locale: source.identity.locale,
        candidateDestinationIds: [],
        proposedDestinationId,
        redundantDestinationIds: [],
      });
    }
  }

  actions.sort(actionOrder);
  const sourceState = [...sources.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((source) => [source.key, source.record.hash, source.url] as const);
  const managedState = [...managed.values()]
    .map(
      (record) =>
        [
          sourceIdentityKey(record.sourceIdentity),
          record.destinationId,
          record.hash,
        ] as const,
    )
    .sort(([left], [right]) => left.localeCompare(right));
  const candidateState = [...candidates.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(
      (candidate) =>
        [
          candidate.id,
          candidate.document,
          resolutions.get(candidate.id),
        ] as const,
    );
  const fingerprint = await sha256(
    canonicalJson({
      config: {
        revision: config.revision,
        connectorKey: config.connectorKey,
        zendeskSubdomain: config.zendeskSubdomain.trim().toLowerCase(),
        locales: [...config.locales].map(normalizeLocale).sort(),
        target: config.target,
      },
      sourceInventory: sourceState,
      quarantined: [...quarantined].sort(),
      manifestRevision,
      managed: managedState,
      fieldAvailability: discovery.fieldAvailability,
      candidates: candidateState,
      actions,
    }),
  );
  const counts = {
    sourceIdentities: sources.size,
    candidates: candidates.size,
    managed: actions.filter((action) => action.classification === "managed")
      .length,
    adopt: actions.filter((action) => action.classification === "adopt").length,
    consolidate: actions.filter(
      (action) => action.classification === "consolidate",
    ).length,
    create: actions.filter((action) => action.classification === "create")
      .length,
    ambiguousUnmatched: actions.filter(
      (action) => action.classification === "ambiguous/unmatched",
    ).length,
  };
  return {
    result: {
      readOnly: true,
      fingerprint,
      fieldAvailability: discovery.fieldAvailability,
      counts,
      actions,
    },
    sources: [...sources.values()].sort((left, right) =>
      left.key.localeCompare(right.key),
    ),
    candidates: [...candidates.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    fieldAvailability: discovery.fieldAvailability,
    resolutions,
    quarantined: [...quarantined].sort(),
  };
}

export async function existingIndexDryRun(
  config: ReconciliationConfig,
  manifest: readonly ManifestRecord[],
  manifestRevision: number,
  dependencies: ExistingIndexDryRunDependencies,
): Promise<ExistingIndexDryRunResult> {
  return (
    await existingIndexProof(config, manifest, manifestRevision, dependencies)
  ).result;
}
