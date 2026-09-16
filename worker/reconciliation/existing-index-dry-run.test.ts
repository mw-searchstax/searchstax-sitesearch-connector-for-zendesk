import { describe, expect, it } from "vitest";

import type { Json } from "../contracts/record.ts";
import type {
  ManifestRecord,
  ReconciliationConfig,
  StagedRecord,
} from "./model.ts";
import {
  existingIndexDryRun,
  parseZendeskArticleUrl,
  type ExistingIndexCandidate,
} from "./existing-index-dry-run.ts";

const config: ReconciliationConfig = {
  revision: 3,
  connectorKey: "docs",
  zendeskSubdomain: "docs",
  locales: ["en-US"],
  target: "local",
};

function source(
  articleId: string,
  url = `https://docs.zendesk.com/hc/en-US/articles/${articleId}-slug`,
): StagedRecord {
  const identity = { subdomain: "docs", articleId, locale: "en_us" };
  const id = `zdg_docs_${articleId}_en_us`;
  const document: Record<string, Json> = { id, url_s: url };
  return {
    id,
    destinationId: id,
    sourceIdentity: identity,
    articleId,
    translationId: `translation-${articleId}`,
    locale: "en_us",
    sourceUpdatedAt: "2026-08-13T00:00:00.000Z",
    document,
    canonical: JSON.stringify(document),
    hash: `hash-${articleId}`,
    byteSize: 20,
    warnings: [],
  };
}

function candidate(
  id: string,
  field: "url" | "url_s" | "ss_url",
  url: string,
): ExistingIndexCandidate {
  return { id, document: { id, [field]: url } };
}

function manifest(record: StagedRecord): ManifestRecord {
  return {
    destinationId: record.destinationId,
    sourceIdentity: record.sourceIdentity,
    translationId: record.translationId,
    sourceUpdatedAt: record.sourceUpdatedAt,
    hash: record.hash,
    lastSeenRunId: "run-1",
    acknowledgedAt: "2026-08-13T00:00:00.000Z",
  };
}

function dependencies(
  records: readonly StagedRecord[],
  candidates: readonly ExistingIndexCandidate[],
) {
  return {
    enumerate: async () => records,
    discoverCandidates: async () => ({
      candidates,
      fieldAvailability: {
        url: { state: "queryable" },
        url_s: { state: "queryable" },
        ss_url: { state: "queryable" },
      } as const,
    }),
  };
}

describe("existing-index dry run", () => {
  it("parses only exact native Zendesk article URLs and ignores slugs/query data", () => {
    expect(
      parseZendeskArticleUrl(
        "https://docs.zendesk.com/hc/en-US/articles/42-old-slug?x=9#part",
        "docs",
      ),
    ).toEqual({ subdomain: "docs", articleId: "42", locale: "en_us" });
    expect(
      parseZendeskArticleUrl(
        "https://docs.zendesk.com/hc/en-us/articles/42",
        "docs",
      ),
    ).toEqual({ subdomain: "docs", articleId: "42", locale: "en_us" });
    expect(
      parseZendeskArticleUrl(
        "https://other.zendesk.com/hc/en-us/articles/42",
        "docs",
      ),
    ).toBeNull();
    expect(
      parseZendeskArticleUrl(
        "https://docs.zendesk.com/hc/en-us/sections/42",
        "docs",
      ),
    ).toBeNull();
    expect(
      parseZendeskArticleUrl(
        "https://docs.zendesk.com/hc/en-us/articles/abc-42",
        "docs",
      ),
    ).toBeNull();
  });

  it("classifies managed, adoption, consolidation, creation, and ambiguity without mutation", async () => {
    const managed = source("1");
    const adopt = source("2");
    const consolidate = source("3");
    const create = source("4");
    const calls = { enumerate: 0, discover: 0 };
    const result = await existingIndexDryRun(config, [manifest(managed)], 8, {
      enumerate: async () => {
        calls.enumerate += 1;
        return [managed, adopt, consolidate, create];
      },
      discoverCandidates: async () => {
        calls.discover += 1;
        return {
          candidates: [
            candidate(managed.id, "url_s", managed.document.url_s as string),
            candidate(
              "legacy-3",
              "url",
              "https://docs.zendesk.com/hc/en-us/articles/3-old",
            ),
            candidate(
              "legacy-2",
              "ss_url",
              "https://docs.zendesk.com/hc/en-us/articles/2-old",
            ),
            candidate(
              "zdg_docs_3_en_us",
              "url_s",
              "https://docs.zendesk.com/hc/en-us/articles/3-new",
            ),
            candidate(
              "wrong-host",
              "url",
              "https://other.zendesk.com/hc/en-us/articles/4",
            ),
          ],
          fieldAvailability: {
            url: { state: "queryable" },
            url_s: { state: "queryable" },
            ss_url: { state: "queryable" },
          } as const,
        };
      },
    });
    expect(result.readOnly).toBe(true);
    expect(result.counts).toEqual({
      sourceIdentities: 4,
      candidates: 5,
      managed: 1,
      adopt: 1,
      consolidate: 1,
      create: 1,
      ambiguousUnmatched: 1,
    });
    expect(
      result.actions.find((action) => action.sourceIdentity?.articleId === "3"),
    ).toMatchObject({
      classification: "consolidate",
      proposedDestinationId: "zdg_docs_3_en_us",
      redundantDestinationIds: ["legacy-3"],
    });
    expect(
      result.actions.find((action) => action.sourceIdentity?.articleId === "1"),
    ).toMatchObject({ classification: "managed" });
    expect(
      result.actions.find((action) => action.sourceIdentity?.articleId === "4"),
    ).toMatchObject({
      classification: "create",
      proposedDestinationId: "zdg_docs_4_en_us",
    });
    expect(calls).toEqual({ enumerate: 1, discover: 1 });
  });

  it("accepts equivalent URL fields and makes candidate ordering irrelevant", async () => {
    const record = source("10");
    const one = candidate("one", "url_s", record.document.url_s as string);
    const two = candidate(
      "two",
      "ss_url",
      "https://docs.zendesk.com/hc/en-us/articles/11",
    );
    const left = await existingIndexDryRun(
      config,
      [],
      0,
      dependencies([record], [one, two]),
    );
    const right = await existingIndexDryRun(
      config,
      [],
      0,
      dependencies([record], [two, one]),
    );
    expect(left.fingerprint).toBe(right.fingerprint);
    expect(left.counts.adopt).toBe(1);
  });

  it("matches a custom-domain candidate only through an enumerated source URL", async () => {
    const record = source(
      "30",
      "https://support.example.com/hc/en-us/articles/30-current#fragment",
    );
    const result = await existingIndexDryRun(
      config,
      [],
      0,
      dependencies(
        [record],
        [
          candidate(
            "legacy-30",
            "url_s",
            "https://support.example.com/hc/en-us/articles/30-current",
          ),
          candidate(
            "untrusted-31",
            "url",
            "https://support.example.com/hc/en-us/articles/31",
          ),
        ],
      ),
    );
    expect(result.counts.adopt).toBe(1);
    expect(result.actions).toContainEqual(
      expect.objectContaining({
        classification: "ambiguous/unmatched",
        candidateDestinationIds: ["untrusted-31"],
        reasonCode: "UNTRUSTED_URL_EVIDENCE",
      }),
    );
  });

  it("rejects a custom URL shared by multiple source identities", async () => {
    const shared = "https://support.example.com/hc/en-us/articles/shared";
    const result = await existingIndexDryRun(
      config,
      [],
      0,
      dependencies(
        [source("31", shared), source("32", shared)],
        [candidate("shared", "url", shared)],
      ),
    );
    expect(result.counts.ambiguousUnmatched).toBe(1);
    expect(result.actions).toContainEqual(
      expect.objectContaining({
        classification: "ambiguous/unmatched",
        reasonCode: "UNTRUSTED_URL_EVIDENCE",
      }),
    );
  });

  it("rejects mixed custom URL evidence and passes current URLs to discovery", async () => {
    const url = "https://support.example.com/hc/en-us/articles/30-current";
    const deps = dependencies(
      [source("30", url)],
      [
        {
          id: "mixed",
          document: {
            id: "mixed",
            url_s: url,
            url: "https://foreign.example.com/article",
          },
        },
      ],
    );
    const result = await existingIndexDryRun(config, [], 0, {
      ...deps,
      discoverCandidates: async (_checkpoint, urls) => {
        expect(urls).toEqual([url]);
        return deps.discoverCandidates();
      },
    });
    expect(result.counts.adopt).toBe(0);
    expect(result.actions).toContainEqual(
      expect.objectContaining({
        candidateDestinationIds: ["mixed"],
        reasonCode: "UNTRUSTED_URL_EVIDENCE",
      }),
    );
  });

  it("binds supported-field availability into the deterministic proof", async () => {
    const record = source("15");
    const candidates = [
      candidate("legacy-15", "url_s", record.document.url_s as string),
    ];
    const queryable = await existingIndexDryRun(
      config,
      [],
      0,
      dependencies([record], candidates),
    );
    const unavailable = await existingIndexDryRun(config, [], 0, {
      enumerate: async () => [record],
      discoverCandidates: async () => ({
        candidates,
        fieldAvailability: {
          url: { state: "unavailable", reasonCode: "UNDEFINED_FIELD" },
          url_s: { state: "queryable" },
          ss_url: { state: "queryable" },
        } as const,
      }),
    });
    expect(queryable.fieldAvailability.url).toEqual({ state: "queryable" });
    expect(unavailable.fieldAvailability.url).toEqual({
      state: "unavailable",
      reasonCode: "UNDEFINED_FIELD",
    });
    expect(unavailable.fingerprint).not.toBe(queryable.fingerprint);
  });

  it("rejects conflicting supported URL evidence instead of choosing a field", async () => {
    const record = source("20");
    const conflicting: ExistingIndexCandidate = {
      id: "conflict",
      document: {
        id: "conflict",
        url: "https://docs.zendesk.com/hc/en-us/articles/20",
        url_s: "https://docs.zendesk.com/hc/en-us/articles/21",
      },
    };
    const result = await existingIndexDryRun(
      config,
      [],
      0,
      dependencies([record], [conflicting]),
    );
    expect(result.counts.ambiguousUnmatched).toBe(1);
    expect(
      result.actions.find((action) =>
        action.candidateDestinationIds.includes("conflict"),
      ),
    ).toMatchObject({
      classification: "ambiguous/unmatched",
      candidateDestinationIds: ["conflict"],
      reasonCode: "CONFLICTING_SOURCE_IDENTITIES",
    });
  });
});
