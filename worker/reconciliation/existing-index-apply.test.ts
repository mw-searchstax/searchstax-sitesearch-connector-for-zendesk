import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  prepareRecordForDestinationId,
  type Json,
} from "../contracts/record.ts";
import {
  existingIndexDryRun,
  type ExistingIndexCandidate,
} from "./existing-index-dry-run.ts";
import {
  existingIndexApply,
  type ExistingIndexApplyDependencies,
} from "./existing-index-apply.ts";
import type {
  ManifestRecord,
  ReconciliationConfig,
  StagedRecord,
} from "./model.ts";

const config: ReconciliationConfig = {
  revision: 1,
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
  const canonical = canonicalJson(document);
  return {
    id,
    destinationId: id,
    sourceIdentity: identity,
    articleId,
    translationId: `translation-${articleId}`,
    locale: "en_us",
    sourceUpdatedAt: "2026-08-13T00:00:00.000Z",
    document,
    canonical,
    hash: `source-${articleId}`,
    byteSize: new TextEncoder().encode(canonical).byteLength,
    warnings: [],
  };
}

function candidate(id: string, url: string): ExistingIndexCandidate {
  return { id, document: { id, url_s: url } };
}

function manifest(
  record: StagedRecord,
  destinationId = record.destinationId,
): ManifestRecord {
  return {
    destinationId,
    sourceIdentity: record.sourceIdentity,
    translationId: record.translationId,
    sourceUpdatedAt: record.sourceUpdatedAt,
    hash: record.hash,
    lastSeenRunId: "run-1",
    acknowledgedAt: "2026-08-13T00:00:00.000Z",
  };
}

function harness(
  records: readonly StagedRecord[],
  candidates: readonly ExistingIndexCandidate[],
  initialManifest: readonly ManifestRecord[] = [],
) {
  const state = {
    records: [...records],
    candidates: new Map(
      candidates.map((item) => [item.id, structuredClone(item)]),
    ),
    manifest: [...initialManifest],
    revision: 0,
    configRevision: 1,
    events: [] as string[],
    failWrite: false,
    failAck: false,
    failAckOnce: false,
    failDeletes: new Set<string>(),
    deferDeletes: false,
    releaseDeferredDeletes: true,
    pendingDeletes: new Set<string>(),
    pendingDeleteDiscoveries: 0,
    discoveryCalls: 0,
  };
  const dependencies: ExistingIndexApplyDependencies = {
    enumerate: async () => state.records,
    discoverCandidates: async () => {
      state.discoveryCalls += 1;
      if (
        state.deferDeletes &&
        state.releaseDeferredDeletes &&
        state.pendingDeletes.size
      ) {
        state.pendingDeleteDiscoveries += 1;
      }
      if (state.releaseDeferredDeletes && state.pendingDeleteDiscoveries >= 2) {
        for (const id of state.pendingDeletes) state.candidates.delete(id);
        state.pendingDeletes.clear();
      }
      return {
        candidates: [...state.candidates.values()],
        fieldAvailability: {
          url: { state: "queryable" },
          url_s: { state: "queryable" },
          ss_url: { state: "queryable" },
        } as const,
      };
    },
    upsert: async (items) => {
      state.events.push(`write:${items[0]!.destinationId}`);
      if (state.failWrite) throw new Error("write failed");
      for (const item of items)
        state.candidates.set(item.destinationId, {
          id: item.destinationId,
          document: structuredClone(item.document),
        });
    },
    deleteExactIds: async (ids) => {
      const id = ids[0]!;
      state.events.push(`delete:${id}`);
      if (state.failDeletes.has(id)) throw new Error(`delete ${id} failed`);
      if (state.deferDeletes) state.pendingDeletes.add(id);
      else state.candidates.delete(id);
    },
    acknowledge: async (items) => {
      state.events.push(`ack:${items[0]!.destinationId}`);
      if (state.failAck || state.failAckOnce) {
        state.failAckOnce = false;
        throw new Error("local acknowledgement failed");
      }
      for (const item of items) {
        state.manifest = state.manifest.filter(
          (record) =>
            JSON.stringify(record.sourceIdentity) !==
            JSON.stringify(item.sourceIdentity),
        );
        state.manifest.push(manifest(item, item.destinationId));
      }
      state.revision += 1;
    },
    manifest: async () => state.manifest,
    manifestRevision: async () => state.revision,
    destinationDocument: async (id) =>
      state.candidates.get(id)?.document ?? null,
    configurationRevision: async () => state.configRevision,
  };
  return { state, dependencies };
}

async function plan(
  state: ReturnType<typeof harness>["state"],
  dependencies: ExistingIndexApplyDependencies,
  currentConfig = config,
) {
  return existingIndexDryRun(
    currentConfig,
    state.manifest,
    state.revision,
    dependencies,
  );
}

async function apply(
  state: ReturnType<typeof harness>["state"],
  dependencies: ExistingIndexApplyDependencies,
  fingerprint: string,
  currentConfig = config,
) {
  return existingIndexApply(
    currentConfig,
    state.manifest,
    state.revision,
    fingerprint,
    true,
    dependencies,
  );
}

describe("existing-index apply", () => {
  it("rejects a custom-domain adoption when current source URL evidence changes", async () => {
    const url = "https://support.example.com/hc/en-us/articles/2-current";
    const fixture = harness([source("2", url)], [candidate("legacy-2", url)]);
    const reviewed = await plan(fixture.state, fixture.dependencies);
    expect(reviewed.counts.adopt).toBe(1);
    fixture.state.records = [source("2", url + "-changed")];
    const result = await apply(
      fixture.state,
      fixture.dependencies,
      reviewed.fingerprint,
    );
    expect(result.status).toBe("rejected");
    expect(fixture.state.events).toEqual([]);
    expect(fixture.state.manifest).toEqual([]);
  });

  it("adopts in place, preserves the ID, hashes the resulting document, and acknowledges before ownership", async () => {
    const record = source("2");
    const fixture = harness(
      [record],
      [candidate("legacy-2", record.document.url_s as string)],
    );
    const dryRun = await plan(fixture.state, fixture.dependencies);
    const result = await apply(
      fixture.state,
      fixture.dependencies,
      dryRun.fingerprint,
    );
    const adopted = fixture.state.manifest[0]!;
    const expected = await prepareRecordForDestinationId(record, "legacy-2");
    expect(result.status).toBe("applied");
    expect(result.counts.adopted).toBe(1);
    expect(fixture.state.candidates.get("legacy-2")?.document).toEqual(
      expected.document,
    );
    expect(adopted.destinationId).toBe("legacy-2");
    expect(adopted.hash).toBe(expected.hash);
    expect(fixture.state.events).toEqual(["write:legacy-2", "ack:legacy-2"]);
    expect(fixture.state.candidates.has("zdg_docs_2_en_us")).toBe(false);
  });

  it("creates the generated ID only after an acknowledged write", async () => {
    const fixture = harness([source("4")], []);
    const dryRun = await plan(fixture.state, fixture.dependencies);
    const result = await apply(
      fixture.state,
      fixture.dependencies,
      dryRun.fingerprint,
    );
    expect(result.status).toBe("applied");
    expect(result.counts.created).toBe(1);
    expect(fixture.state.manifest[0]?.destinationId).toBe("zdg_docs_4_en_us");
  });

  it("does not rewrite an already-managed document that already matches", async () => {
    const record = source("40");
    const expected = await prepareRecordForDestinationId(record, record.id);
    const fixture = harness(
      [record],
      [{ id: record.id, document: record.document }],
      [{ ...manifest(record), hash: expected.hash }],
    );
    const dryRun = await plan(fixture.state, fixture.dependencies);
    const result = await apply(
      fixture.state,
      fixture.dependencies,
      dryRun.fingerprint,
    );
    expect(result.status).toBe("applied");
    expect(fixture.state.events).toEqual([]);
  });

  it("fails closed on a write and retries without creating a generated duplicate", async () => {
    const record = source("5");
    const fixture = harness(
      [record],
      [candidate("legacy-5", record.document.url_s as string)],
    );
    fixture.state.failWrite = true;
    const dryRun = await plan(fixture.state, fixture.dependencies);
    const failed = await apply(
      fixture.state,
      fixture.dependencies,
      dryRun.fingerprint,
    );
    expect(failed.status).toBe("failed");
    expect(fixture.state.manifest).toHaveLength(0);
    expect(fixture.state.events).toEqual(["write:legacy-5"]);

    fixture.state.failWrite = false;
    const retryPlan = await plan(fixture.state, fixture.dependencies);
    const retried = await apply(
      fixture.state,
      fixture.dependencies,
      retryPlan.fingerprint,
    );
    expect(retried.status).toBe("applied");
    expect(fixture.state.manifest[0]?.destinationId).toBe("legacy-5");
    expect(fixture.state.candidates.has("zdg_docs_5_en_us")).toBe(false);
  });

  it("does not claim ownership after external success and local acknowledgement failure", async () => {
    const record = source("6");
    const fixture = harness(
      [record],
      [candidate("legacy-6", record.document.url_s as string)],
    );
    fixture.state.failAckOnce = true;
    const dryRun = await plan(fixture.state, fixture.dependencies);
    const failed = await apply(
      fixture.state,
      fixture.dependencies,
      dryRun.fingerprint,
    );
    expect(failed.status).toBe("partial");
    expect(fixture.state.manifest).toHaveLength(0);
    expect(fixture.state.candidates.has("legacy-6")).toBe(true);

    const retryPlan = await plan(fixture.state, fixture.dependencies);
    const retried = await apply(
      fixture.state,
      fixture.dependencies,
      retryPlan.fingerprint,
    );
    expect(retried.status).toBe("applied");
    expect(fixture.state.manifest[0]?.destinationId).toBe("legacy-6");
  });

  it("consolidates only after survivor acknowledgement and leaves ambiguous records untouched", async () => {
    const record = source("7");
    const fixture = harness(
      [record],
      [
        candidate("legacy-7", record.document.url_s as string),
        candidate("zdg_docs_7_en_us", record.document.url_s as string),
        candidate("ambiguous-7", "https://other.example/articles/7"),
      ],
    );
    const before = canonicalJson(
      fixture.state.candidates.get("ambiguous-7")?.document,
    );
    const dryRun = await plan(fixture.state, fixture.dependencies);
    expect(
      dryRun.actions.find((action) => action.sourceIdentity?.articleId === "7"),
    ).toMatchObject({
      classification: "consolidate",
      proposedDestinationId: "zdg_docs_7_en_us",
      redundantDestinationIds: ["legacy-7"],
    });
    const result = await apply(
      fixture.state,
      fixture.dependencies,
      dryRun.fingerprint,
    );
    expect(result.status).toBe("applied");
    expect(fixture.state.events).toEqual([
      "write:zdg_docs_7_en_us",
      "ack:zdg_docs_7_en_us",
      "delete:legacy-7",
    ]);
    expect(fixture.state.candidates.has("legacy-7")).toBe(false);
    expect(
      canonicalJson(fixture.state.candidates.get("ambiguous-7")?.document),
    ).toBe(before);
  });

  it("rechecks successful deletes while destination visibility catches up", async () => {
    const record = source("15");
    const fixture = harness(
      [record],
      [
        candidate("legacy-15", record.document.url_s as string),
        candidate("legacy-15-b", record.document.url_s as string),
      ],
    );
    fixture.state.deferDeletes = true;
    fixture.dependencies.finalVerificationAttempts = 2;
    fixture.dependencies.finalVerificationDelayMs = 0;
    const dryRun = await plan(fixture.state, fixture.dependencies);
    const result = await apply(
      fixture.state,
      fixture.dependencies,
      dryRun.fingerprint,
    );
    expect(result.status).toBe("applied");
    expect(result.finalVerification).toBe("passed");
    expect(fixture.state.discoveryCalls).toBe(4);
    expect(fixture.state.pendingDeletes.size).toBe(0);
  });

  it("fails closed after bounded delete-visibility retries", async () => {
    const record = source("16");
    const fixture = harness(
      [record],
      [
        candidate("legacy-16", record.document.url_s as string),
        candidate("legacy-16-b", record.document.url_s as string),
      ],
    );
    fixture.state.deferDeletes = true;
    fixture.state.releaseDeferredDeletes = false;
    fixture.dependencies.finalVerificationAttempts = 2;
    fixture.dependencies.finalVerificationDelayMs = 0;
    const dryRun = await plan(fixture.state, fixture.dependencies);
    const result = await apply(
      fixture.state,
      fixture.dependencies,
      dryRun.fingerprint,
    );
    expect(result.status).toBe("partial");
    expect(result.finalVerification).toBe("failed");
    expect(result.reasonCode).toBe("FINAL_VERIFICATION_VISIBILITY_TIMEOUT");
    expect(fixture.state.discoveryCalls).toBe(4);
    expect(fixture.state.pendingDeletes.size).toBe(1);
  });

  it("keeps survivor ownership and residuals after a redundant delete failure, then retries safely", async () => {
    const record = source("8");
    const fixture = harness(
      [record],
      [
        candidate("legacy-8-a", record.document.url_s as string),
        candidate("legacy-8-b", record.document.url_s as string),
      ],
    );
    fixture.state.failDeletes.add("legacy-8-b");
    const dryRun = await plan(fixture.state, fixture.dependencies);
    const partial = await apply(
      fixture.state,
      fixture.dependencies,
      dryRun.fingerprint,
    );
    expect(partial.status).toBe("partial");
    expect(partial.counts.consolidated).toBe(1);
    expect(partial.unresolvedResiduals).toEqual(["legacy-8-b"]);
    expect(fixture.state.manifest[0]?.destinationId).toBe("legacy-8-a");
    expect(fixture.state.candidates.has("legacy-8-a")).toBe(true);

    fixture.state.failDeletes.clear();
    const retryPlan = await plan(fixture.state, fixture.dependencies);
    const retried = await apply(
      fixture.state,
      fixture.dependencies,
      retryPlan.fingerprint,
    );
    expect(retried.status).toBe("applied");
    expect(fixture.state.manifest[0]?.destinationId).toBe("legacy-8-a");
    expect(fixture.state.candidates.has("legacy-8-b")).toBe(false);
  });

  it("uses the approved survivor priority and deterministic fallback", async () => {
    const managedSource = source("11");
    const managedFixture = harness(
      [managedSource],
      [
        candidate("managed-11", managedSource.document.url_s as string),
        candidate("other-11", managedSource.document.url_s as string),
      ],
      [manifest(managedSource, "managed-11")],
    );
    const managedPlan = await plan(
      managedFixture.state,
      managedFixture.dependencies,
    );
    expect(managedPlan.actions[0]?.proposedDestinationId).toBe("managed-11");

    const exactSource = source("12");
    const exactFixture = harness(
      [exactSource],
      [
        candidate(
          "not-exact-12",
          "https://docs.zendesk.com/hc/en-US/articles/12-old",
        ),
        candidate("exact-12", exactSource.document.url_s as string),
      ],
    );
    const exactPlan = await plan(exactFixture.state, exactFixture.dependencies);
    expect(exactPlan.actions[0]?.proposedDestinationId).toBe("exact-12");

    const fallbackSource = source("13");
    const left = harness(
      [fallbackSource],
      [
        candidate("b-13", "https://docs.zendesk.com/hc/en-US/articles/13-b"),
        candidate("a-13", "https://docs.zendesk.com/hc/en-US/articles/13-a"),
      ],
    );
    const right = harness(
      [fallbackSource],
      [
        candidate("a-13", "https://docs.zendesk.com/hc/en-US/articles/13-a"),
        candidate("b-13", "https://docs.zendesk.com/hc/en-US/articles/13-b"),
      ],
    );
    const leftPlan = await plan(left.state, left.dependencies);
    const rightPlan = await plan(right.state, right.dependencies);
    expect(leftPlan.actions[0]?.proposedDestinationId).toBe("a-13");
    expect(rightPlan.actions[0]?.proposedDestinationId).toBe("a-13");
  });

  it("does not delete redundant candidates when survivor convergence fails", async () => {
    const record = source("14");
    const fixture = harness(
      [record],
      [
        candidate("legacy-14-a", record.document.url_s as string),
        candidate("legacy-14-b", record.document.url_s as string),
      ],
    );
    fixture.state.failWrite = true;
    const dryRun = await plan(fixture.state, fixture.dependencies);
    const result = await apply(
      fixture.state,
      fixture.dependencies,
      dryRun.fingerprint,
    );
    expect(result.status).toBe("failed");
    expect(fixture.state.events).toEqual(["write:legacy-14-a"]);
    expect(fixture.state.candidates.has("legacy-14-b")).toBe(true);
    expect(fixture.state.manifest).toHaveLength(0);
  });

  it("recovers a fresh local state with adoption, creation, consolidation, and untouched ambiguity", async () => {
    const adopt = source("20");
    const create = source("21");
    const consolidate = source("22");
    const fixture = harness(
      [adopt, create, consolidate, source("23")],
      [
        candidate("legacy-20", adopt.document.url_s as string),
        candidate("legacy-22-a", consolidate.document.url_s as string),
        candidate("legacy-22-b", consolidate.document.url_s as string),
        candidate("ambiguous-23", "https://other.example/articles/23"),
      ],
    );
    const ambiguousBefore = canonicalJson(
      fixture.state.candidates.get("ambiguous-23")?.document,
    );
    const dryRun = await plan(fixture.state, fixture.dependencies);
    expect(dryRun.counts).toMatchObject({
      adopt: 1,
      create: 2,
      consolidate: 1,
      ambiguousUnmatched: 1,
    });
    const result = await apply(
      fixture.state,
      fixture.dependencies,
      dryRun.fingerprint,
    );
    expect(result.status).toBe("applied");
    expect(
      fixture.state.manifest.map((item) => item.destinationId).sort(),
    ).toEqual([
      "legacy-20",
      "legacy-22-a",
      "zdg_docs_21_en_us",
      "zdg_docs_23_en_us",
    ]);
    expect(fixture.state.candidates.has("legacy-22-b")).toBe(false);
    expect(
      canonicalJson(fixture.state.candidates.get("ambiguous-23")?.document),
    ).toBe(ambiguousBefore);
  });

  it.each([
    [
      "configuration revision",
      (state: ReturnType<typeof harness>["state"]) => {
        state.configRevision = 2;
      },
    ],
    [
      "source inventory",
      (state: ReturnType<typeof harness>["state"]) => {
        state.records = [source("91")];
      },
    ],
    [
      "candidate added",
      (state: ReturnType<typeof harness>["state"]) => {
        state.candidates.set(
          "new-candidate",
          candidate("new-candidate", "https://other.example/articles/1"),
        );
      },
    ],
    [
      "candidate removed",
      (state: ReturnType<typeof harness>["state"]) => {
        state.candidates.clear();
      },
    ],
    [
      "candidate URL identity",
      (state: ReturnType<typeof harness>["state"]) => {
        state.candidates.set(
          "legacy-9",
          candidate(
            "legacy-9",
            "https://docs.zendesk.com/hc/en-US/articles/91-other",
          ),
        );
      },
    ],
    [
      "manifest mapping",
      (state: ReturnType<typeof harness>["state"]) => {
        state.manifest = [manifest(source("9"), "managed-9")];
        state.revision += 1;
      },
    ],
    ["reviewed fingerprint", () => undefined],
  ])("rejects a changed %s before the first mutation", async (name, change) => {
    const record = source("9");
    const fixture = harness(
      [record],
      [candidate("legacy-9", record.document.url_s as string)],
    );
    const dryRun = await plan(fixture.state, fixture.dependencies);
    change(fixture.state);
    const result = await apply(
      fixture.state,
      fixture.dependencies,
      name === "reviewed fingerprint" ? "wrong" : dryRun.fingerprint,
      name === "configuration revision" ? { ...config, revision: 2 } : config,
    );
    expect(result.status).toBe("rejected");
    expect(result.reasonCode).toBe("REVIEWED_PROOF_CHANGED");
    expect(fixture.state.events).toEqual([]);
  });

  it("requires explicit legacy-ingestion confirmation without touching state", async () => {
    const record = source("10");
    const fixture = harness([record], []);
    const dryRun = await plan(fixture.state, fixture.dependencies);
    const result = await existingIndexApply(
      config,
      fixture.state.manifest,
      fixture.state.revision,
      dryRun.fingerprint,
      false,
      fixture.dependencies,
    );
    expect(result.reasonCode).toBe("LEGACY_INGESTION_NOT_PAUSED");
    expect(fixture.state.events).toEqual([]);
  });
});
