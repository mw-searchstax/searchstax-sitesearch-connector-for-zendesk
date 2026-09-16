import {
  ContractError,
  deleteExactIds,
  listEligibleTranslations,
  listOwnedIds,
  listZendeskCandidates,
  prepareRecord,
  selectExactId,
  serializeUpsert,
  upsert,
  waitForOwnedIdParity,
  waitForSampledFields,
  withConnectorKey,
} from "../contracts/index.ts";
import type { SearchStaxSettings } from "../contracts/searchstax.ts";
import type {
  Brand,
  ZendeskAuthorizationProvider,
  ZendeskAuthentication,
} from "../contracts/zendesk.ts";
import type { ReconciliationDependencies } from "./engine.ts";
import {
  canonicalZendeskSourceIdentity,
  type ReconciliationConfig,
  type StagedRecord,
} from "./model.ts";

export interface RuntimeSecrets {
  zendesk: ZendeskAuthentication;
  searchstax: SearchStaxSettings;
}

export interface RuntimeConfiguration {
  reconciliation: ReconciliationConfig;
  brand: Brand;
  secrets: RuntimeSecrets;
  zendeskAuthorization?: ZendeskAuthorizationProvider;
}

export function reconciliationDependencies(
  runtime: RuntimeConfiguration,
): ReconciliationDependencies {
  const zendesk = {
    credentials: runtime.secrets.zendesk,
    authorization: runtime.zendeskAuthorization,
  };
  const destination = { settings: runtime.secrets.searchstax };
  const stableJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  const destinationProof = async (
    ids: readonly string[],
    checkpoint: () => Promise<void>,
  ) => {
    const records: [string, Record<string, unknown> | null][] = [];
    for (const id of [...ids].sort()) {
      await checkpoint();
      records.push([id, await selectExactId(destination, id)]);
    }
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(stableJson(records)),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  };
  return {
    enumerate: async (
      locale,
      checkpoint,
      quarantine,
      articleId,
    ): Promise<StagedRecord[]> => {
      const stableId = (articleId: string, normalizedLocale: string) =>
        `zdg_${runtime.reconciliation.connectorKey}_${articleId}_${normalizedLocale}`;
      const publicUrl = (value: string, articleId: string) => {
        try {
          const candidate = new URL(value);
          if (
            candidate.protocol !== "https:" ||
            candidate.username ||
            candidate.password
          )
            throw new Error();
          return candidate.toString();
        } catch {
          return new URL(
            `/hc/${encodeURIComponent(locale)}/articles/${articleId}`,
            `https://${runtime.brand.subdomain}.zendesk.com`,
          ).toString();
        }
      };
      const source = withConnectorKey(
        await listEligibleTranslations(zendesk, runtime.brand, locale, {
          ...(articleId ? { articleId } : {}),
          checkpoint,
          onQuarantine: (record) =>
            quarantine({
              id: stableId(record.articleId, record.locale),
              ...record,
            }),
        }),
        runtime.reconciliation.connectorKey,
      );
      const result: StagedRecord[] = [];
      for (const input of source) {
        await checkpoint();
        try {
          const prepared = await prepareRecord(input);
          result.push({
            ...prepared,
            destinationId: prepared.id,
            sourceIdentity: canonicalZendeskSourceIdentity(
              runtime.brand.subdomain,
              input.articleId,
              input.locale,
            ),
            articleId: input.articleId,
            translationId: input.translationId,
            locale: input.locale,
            sourceUpdatedAt: input.updatedAt,
          });
        } catch (error) {
          if (!(error instanceof ContractError)) throw error;
          quarantine({
            id: stableId(input.articleId, input.locale),
            articleId: input.articleId,
            locale: input.locale,
            publicTitle: input.title,
            publicUrl: publicUrl(input.url, input.articleId),
            reasonCode:
              error.code === "RECORD_TOO_LARGE"
                ? "RECORD_TOO_LARGE"
                : "INVALID_SOURCE_RECORD",
          });
        }
      }
      return result;
    },
    upsert: async (records) =>
      upsert(destination, serializeUpsert(records), true),
    deleteExactIds: async (ids, trustedManagedIds) =>
      deleteExactIds(destination, ids, trustedManagedIds),
    destinationIds: (checkpoint) =>
      listOwnedIds(
        destination,
        runtime.reconciliation.connectorKey,
        runtime.reconciliation.target === "hosted" ? 500 : 5_000,
        checkpoint,
      ),
    destinationDocument: (id) => selectExactId(destination, id),
    discoverCandidates: (checkpoint, sourceUrls) =>
      listZendeskCandidates(
        destination,
        runtime.reconciliation.zendeskSubdomain,
        runtime.reconciliation.target === "hosted" ? 500 : 5_000,
        checkpoint,
        sourceUrls,
      ),
    destinationProof,
    verifyFields: async (records, checkpoint) =>
      waitForSampledFields(destination, records, checkpoint),
    verify: async (records, checkpoint, preservedIds = [], optionalIds = []) =>
      waitForOwnedIdParity(
        destination,
        runtime.reconciliation.connectorKey,
        [
          ...records.map((record) => record.destinationId),
          ...preservedIds,
        ].sort(),
        checkpoint,
        optionalIds,
      ),
  };
}
