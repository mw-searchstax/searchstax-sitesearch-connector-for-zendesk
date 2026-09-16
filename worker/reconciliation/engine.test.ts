import { describe, expect, it, vi } from "vitest";

import { ContractError } from "../contracts/shared.ts";
import { prepareRecordForDestinationId } from "../contracts/record.ts";
import {
  admitReconciliation,
  confirmDeletion,
  reconcileArticle,
  reconcile,
  type ReconciliationDependencies,
} from "./engine.ts";
import { MemoryReconciliationStore } from "./memory-store.ts";
import {
  emptyCounts,
  type ManifestRecord,
  type ReconciliationConfig,
  type StagedRecord,
} from "./model.ts";

const config: ReconciliationConfig = {
  revision: 1,
  connectorKey: "p03",
  zendeskSubdomain: "example",
  locales: ["en-US"],
  target: "local",
};

function staged(
  id: number,
  hash = `hash-${id}`,
  body = `Body ${id}`,
): StagedRecord {
  const stableId = `zdg_p03_${id}_en_us`;
  const document = {
    id: stableId,
    connector_key_s: "p03",
    body_text_txt_en: body,
  };
  const canonical = JSON.stringify(document);
  return {
    id: stableId,
    destinationId: stableId,
    sourceIdentity: {
      subdomain: "example",
      articleId: String(id),
      locale: "en_us",
    },
    articleId: String(id),
    translationId: String(id + 100),
    locale: "en_us",
    sourceUpdatedAt: "2026-08-02T12:00:00.000Z",
    document,
    canonical,
    hash,
    byteSize: new TextEncoder().encode(canonical).byteLength,
    warnings: [],
  };
}

function manifest(record: StagedRecord, runId = "prior"): ManifestRecord {
  return {
    destinationId: record.destinationId,
    sourceIdentity: record.sourceIdentity,
    translationId: record.translationId,
    sourceUpdatedAt: record.sourceUpdatedAt,
    hash: record.hash,
    lastSeenRunId: runId,
    acknowledgedAt: "2026-08-01T12:00:00.000Z",
  };
}

function dependencies(
  records: readonly StagedRecord[],
  destinationIds: readonly string[] = records.map(
    (record) => record.destinationId,
  ),
): ReconciliationDependencies & {
  upsert: ReturnType<typeof vi.fn>;
  deleteExactIds: ReturnType<typeof vi.fn>;
  destinationIds: ReturnType<typeof vi.fn>;
  verifyFields: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
} {
  return {
    enumerate: vi.fn(async () => records),
    upsert: vi.fn(async () => undefined),
    deleteExactIds: vi.fn(async () => undefined),
    destinationIds: vi.fn(async () => destinationIds),
    verifyFields: vi.fn(async () => undefined),
    verify: vi.fn(async () => undefined),
    now: () => "2026-08-02T12:00:00.000Z",
    randomId: () => "plan-1",
  };
}

async function admit(
  store: MemoryReconciliationStore,
  runId: string,
  selectedConfig = config,
) {
  await expect(
    admitReconciliation(
      store,
      selectedConfig,
      runId,
      `workflow-${runId}`,
      async () => false,
    ),
  ).resolves.toBe(true);
}

describe("P03 durable reconciliation", () => {
  it("records fixed-shape phase, batch, and terminal telemetry", async () => {
    const store = new MemoryReconciliationStore();
    await admit(store, "run-telemetry");

    await expect(
      reconcile(store, config, "run-telemetry", dependencies([staged(1)])),
    ).resolves.toMatchObject({ state: "succeeded" });

    expect(store.telemetryEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-telemetry",
          phase: "enumerating",
          event: "phase_started",
          visibility: "diagnostic",
        }),
        expect.objectContaining({
          runId: "run-telemetry",
          phase: "writing",
          event: "batch_acknowledged",
          visibility: "diagnostic",
          batchNumber: 1,
          recordCount: 1,
          durationMs: 0,
        }),
        expect.objectContaining({
          runId: "run-telemetry",
          phase: "succeeded",
          event: "run_succeeded",
          visibility: "diagnostic",
          durationMs: 0,
        }),
      ]),
    );
    expect(JSON.stringify(store.telemetryEvents)).not.toContain("Body 1");
  });

  it("writes an initial corpus, suppresses an identical replay, and updates a changed stable ID", async () => {
    const store = new MemoryReconciliationStore();
    const first = staged(1);
    await admit(store, "run-1");
    const initial = dependencies([first]);
    await expect(
      reconcile(store, config, "run-1", initial),
    ).resolves.toMatchObject({
      state: "succeeded",
      counts: { created: 1, unchanged: 0 },
    });
    expect(initial.upsert).toHaveBeenCalledOnce();
    expect(initial.verifyFields).toHaveBeenCalledWith(
      [first],
      expect.any(Function),
    );

    await admit(store, "run-2");
    const replay = dependencies([first]);
    await expect(
      reconcile(store, config, "run-2", replay),
    ).resolves.toMatchObject({
      state: "succeeded",
      counts: { created: 0, unchanged: 1 },
    });
    expect(replay.upsert).not.toHaveBeenCalled();
    expect(replay.verifyFields).toHaveBeenCalledWith(
      [first],
      expect.any(Function),
    );

    await admit(store, "run-3");
    const changed = dependencies([staged(1, "changed-hash", "Changed")]);
    await expect(
      reconcile(store, config, "run-3", changed),
    ).resolves.toMatchObject({ state: "succeeded", counts: { changed: 1 } });
    expect(changed.upsert).toHaveBeenCalledOnce();
    expect(changed.verifyFields).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          destinationId: first.destinationId,
          hash: "changed-hash",
        }),
      ],
      expect.any(Function),
    );
    expect((await store.manifest())[0]).toMatchObject({
      destinationId: first.destinationId,
      hash: "changed-hash",
    });
  });

  it("preserves an adopted ID and suppresses an unchanged replay", async () => {
    const store = new MemoryReconciliationStore();
    const generated = staged(1);
    const adopted = await prepareRecordForDestinationId(generated, "legacy-1");
    store.manifestRecords.set("legacy-1", {
      ...manifest(generated),
      destinationId: "legacy-1",
      hash: adopted.hash,
    });
    await admit(store, "run-adopted-unchanged");
    const deps = dependencies([generated], ["legacy-1"]);

    await expect(
      reconcile(store, config, "run-adopted-unchanged", deps),
    ).resolves.toMatchObject({
      state: "succeeded",
      counts: { created: 0, changed: 0, unchanged: 1 },
    });
    expect(deps.upsert).not.toHaveBeenCalled();
    expect(deps.verifyFields).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          destinationId: "legacy-1",
          hash: adopted.hash,
        }),
      ],
      expect.any(Function),
    );
  });

  it("updates changed adopted content in place", async () => {
    const store = new MemoryReconciliationStore();
    const original = staged(1);
    const adopted = await prepareRecordForDestinationId(original, "legacy-1");
    store.manifestRecords.set("legacy-1", {
      ...manifest(original),
      destinationId: "legacy-1",
      hash: adopted.hash,
    });
    await admit(store, "run-adopted-changed");
    const changed = staged(1, "changed-hash", "Changed");
    const expected = await prepareRecordForDestinationId(changed, "legacy-1");
    const deps = dependencies([changed], ["legacy-1"]);

    await expect(
      reconcile(store, config, "run-adopted-changed", deps),
    ).resolves.toMatchObject({ state: "succeeded", counts: { changed: 1 } });
    expect(deps.upsert).toHaveBeenCalledWith([
      expect.objectContaining({
        destinationId: "legacy-1",
        hash: expected.hash,
        canonical: expected.canonical,
      }),
    ]);
    expect((await store.manifest())[0]).toMatchObject({
      destinationId: "legacy-1",
      hash: expected.hash,
    });
  });

  it("repairs a missing adopted destination in place", async () => {
    const store = new MemoryReconciliationStore();
    const generated = staged(1);
    const adopted = await prepareRecordForDestinationId(generated, "legacy-1");
    store.manifestRecords.set("legacy-1", {
      ...manifest(generated),
      destinationId: "legacy-1",
      hash: adopted.hash,
    });
    await admit(store, "run-adopted-repair");
    const deps = dependencies([generated], []);

    await expect(
      reconcile(store, config, "run-adopted-repair", deps),
    ).resolves.toMatchObject({ state: "succeeded", counts: { changed: 1 } });
    expect(deps.upsert).toHaveBeenCalledWith([
      expect.objectContaining({
        destinationId: "legacy-1",
        hash: adopted.hash,
      }),
    ]);
    expect((await store.manifest())[0]).toMatchObject({
      destinationId: "legacy-1",
      hash: adopted.hash,
    });
  });

  it("fails closed when adopted ownership collides", async () => {
    const store = new MemoryReconciliationStore();
    const first = staged(1);
    const second = { ...staged(2), destinationId: "legacy-1" };
    store.manifestRecords.set("legacy-1", {
      ...manifest(first),
      destinationId: "legacy-1",
    });
    await admit(store, "run-adopted-collision");
    const deps = dependencies([first, second], ["legacy-1"]);

    await expect(
      reconcile(store, config, "run-adopted-collision", deps),
    ).resolves.toMatchObject({ state: "failed" });
    expect(deps.upsert).not.toHaveBeenCalled();
    expect(await store.manifest()).toEqual([
      expect.objectContaining({ destinationId: "legacy-1" }),
    ]);
  });

  it("repairs a manifest-equal record missing from the destination", async () => {
    const store = new MemoryReconciliationStore();
    const record = staged(1);
    store.manifestRecords.set(record.id, manifest(record));
    await admit(store, "run-repair");
    const deps = dependencies([record], []);

    await expect(
      reconcile(store, config, "run-repair", deps),
    ).resolves.toMatchObject({
      state: "succeeded",
      counts: { created: 0, changed: 1, unchanged: 0 },
    });
    expect(deps.upsert).toHaveBeenCalledWith([record]);
    expect((await store.manifest())[0]).toMatchObject({
      destinationId: record.destinationId,
      hash: record.hash,
      lastSeenRunId: "run-repair",
    });
    expect(store.telemetryEvents).toContainEqual(
      expect.objectContaining({
        event: "destination_repair_planned",
        visibility: "diagnostic",
        recordCount: 1,
      }),
    );
  });

  it("repairs multiple manifest-equal records through the existing changed batch", async () => {
    const store = new MemoryReconciliationStore();
    const records = [staged(1), staged(2), staged(3)];
    for (const record of records)
      store.manifestRecords.set(record.id, manifest(record));
    await admit(store, "run-repairs");
    const deps = dependencies(records, []);

    await expect(
      reconcile(store, config, "run-repairs", deps),
    ).resolves.toMatchObject({ state: "succeeded", counts: { changed: 3 } });
    expect(deps.upsert).toHaveBeenCalledOnce();
    expect(deps.upsert).toHaveBeenCalledWith(records);
  });

  it("does not acknowledge a failed repair batch", async () => {
    const store = new MemoryReconciliationStore();
    const record = staged(1);
    store.manifestRecords.set(record.id, manifest(record));
    await admit(store, "run-repair-failed");
    const deps = dependencies([record], []);
    deps.upsert.mockRejectedValueOnce(new Error("synthetic repair failure"));

    await expect(
      reconcile(store, config, "run-repair-failed", deps),
    ).resolves.toMatchObject({ state: "failed", counts: { changed: 1 } });
    expect(await store.manifest()).toEqual([manifest(record)]);
    expect(deps.verifyFields).not.toHaveBeenCalled();
  });

  it("fails before mutation when the pre-plan destination inventory is unavailable", async () => {
    const store = new MemoryReconciliationStore();
    const record = staged(1);
    store.manifestRecords.set(record.id, manifest(record));
    await admit(store, "run-inventory-failed");
    const deps = dependencies([record], [record.id]);
    const markUnchanged = vi.spyOn(store, "markUnchanged");
    deps.destinationIds.mockRejectedValueOnce(
      new ContractError("INVALID_RESPONSE", "synthetic incomplete inventory"),
    );

    await expect(
      reconcile(store, config, "run-inventory-failed", deps),
    ).resolves.toMatchObject({ state: "failed" });
    expect(deps.upsert).not.toHaveBeenCalled();
    expect(deps.deleteExactIds).not.toHaveBeenCalled();
    expect(deps.verifyFields).not.toHaveBeenCalled();
    expect(markUnchanged).not.toHaveBeenCalled();
    expect(await store.manifest()).toEqual([manifest(record)]);
  });

  it("preserves created, changed, repaired, unchanged, and stale actions together", async () => {
    const store = new MemoryReconciliationStore();
    const created = staged(1);
    const changed = staged(2, "new-hash", "Changed");
    const repaired = staged(3);
    const unchanged = staged(4);
    const stale = staged(5);
    const retained = Array.from({ length: 9 }, (_, index) => staged(index + 6));
    store.manifestRecords.set(changed.id, manifest(staged(2)));
    store.manifestRecords.set(repaired.id, manifest(repaired));
    store.manifestRecords.set(unchanged.id, manifest(unchanged));
    store.manifestRecords.set(stale.id, manifest(stale));
    for (const record of retained)
      store.manifestRecords.set(record.id, manifest(record));
    await admit(store, "run-mixed");
    const deps = dependencies(
      [created, changed, repaired, unchanged, ...retained],
      [changed.id, unchanged.id, ...retained.map((record) => record.id)],
    );

    await expect(
      reconcile(store, config, "run-mixed", deps),
    ).resolves.toMatchObject({
      state: "succeeded",
      counts: { created: 1, changed: 2, unchanged: 10, stale: 1 },
    });
    expect(deps.upsert).toHaveBeenCalledWith([created, changed, repaired]);
    expect(deps.deleteExactIds).toHaveBeenCalledWith([stale.id]);
  });

  it("sees a repaired record as unchanged on the next inventory-backed run", async () => {
    const store = new MemoryReconciliationStore();
    const record = staged(1);
    store.manifestRecords.set(record.id, manifest(record));
    await admit(store, "run-repair-once");
    const repair = dependencies([record], []);
    await expect(
      reconcile(store, config, "run-repair-once", repair),
    ).resolves.toMatchObject({ counts: { changed: 1 } });

    await admit(store, "run-repair-replay");
    const replay = dependencies([record], [record.id]);
    await expect(
      reconcile(store, config, "run-repair-replay", replay),
    ).resolves.toMatchObject({
      state: "succeeded",
      counts: { changed: 0, unchanged: 1 },
    });
    expect(replay.upsert).not.toHaveBeenCalled();
  });

  it("keeps final parity authoritative after a successful repair write", async () => {
    const store = new MemoryReconciliationStore();
    const record = staged(1);
    store.manifestRecords.set(record.id, manifest(record));
    await admit(store, "run-final-parity");
    const deps = dependencies([record], []);
    deps.verify.mockRejectedValueOnce(
      new ContractError("DESTINATION_PARITY_MISMATCH", "synthetic mismatch"),
    );

    await expect(
      reconcile(store, config, "run-final-parity", deps),
    ).resolves.toMatchObject({ state: "failed", counts: { changed: 1 } });
    expect(deps.upsert).toHaveBeenCalledOnce();
    expect((await store.manifest())[0]).toMatchObject({
      lastSeenRunId: "run-final-parity",
    });
  });

  it("quarantines one known bad identity, preserves its last good document, and degrades after parity", async () => {
    const store = new MemoryReconciliationStore();
    const healthy = staged(1);
    const quarantined = staged(2);
    store.manifestRecords.set(quarantined.id, manifest(quarantined));
    await admit(store, "run-degraded");
    const deps = dependencies([healthy]);
    deps.enumerate = vi.fn(async (_locale, _checkpoint, report) => {
      report({
        id: quarantined.id,
        articleId: quarantined.articleId,
        locale: quarantined.locale,
        publicTitle: "Public article 2",
        publicUrl: "https://example.zendesk.com/hc/en-us/articles/2",
        reasonCode: "INVALID_SOURCE_RECORD",
      });
      return [healthy];
    });

    await expect(
      reconcile(store, config, "run-degraded", deps),
    ).resolves.toMatchObject({
      state: "degraded",
      counts: { source: 2, quarantined: 1 },
    });
    expect(deps.upsert).toHaveBeenCalledWith([healthy]);
    expect(deps.deleteExactIds).not.toHaveBeenCalled();
    expect(deps.verify).toHaveBeenCalledWith([healthy], expect.any(Function), [
      quarantined.id,
    ]);
    expect(await store.manifest()).toHaveLength(2);
    expect(store.manifestRecords.get(quarantined.id)).toEqual(
      manifest(quarantined),
    );
    expect(store.issueRecords).toEqual([
      expect.objectContaining({
        articleId: "2",
        locale: "en_us",
        reasonCode: "INVALID_SOURCE_RECORD",
        state: "active",
      }),
    ]);
  });

  it("resolves the active issue after a complete repaired locale run", async () => {
    const store = new MemoryReconciliationStore();
    await admit(store, "run-bad");
    const bad = dependencies([]);
    bad.enumerate = vi.fn(async (_locale, _checkpoint, report) => {
      report({
        id: staged(1).id,
        articleId: "1",
        locale: "en_us",
        publicTitle: "Public article 1",
        publicUrl: "https://example.zendesk.com/hc/en-us/articles/1",
        reasonCode: "INVALID_SOURCE_RECORD",
      });
      return [];
    });
    await reconcile(store, config, "run-bad", bad);
    expect(store.issueRecords).toEqual([
      expect.objectContaining({ state: "active" }),
    ]);

    await admit(store, "run-repaired");
    await reconcile(store, config, "run-repaired", dependencies([staged(1)]));
    expect(store.issueRecords).toEqual([
      expect.objectContaining({
        state: "resolved",
        resolvedAt: "2026-08-02T12:00:00.000Z",
      }),
    ]);
  });

  it("deletes an exact stale set only at or below the 20 percent guard boundary", async () => {
    const store = new MemoryReconciliationStore();
    for (let id = 1; id <= 10; id += 1)
      store.manifestRecords.set(staged(id).id, manifest(staged(id)));
    const current = Array.from({ length: 8 }, (_, index) => staged(index + 1));
    await admit(store, "run-delete");
    const deps = dependencies(current);

    await expect(
      reconcile(store, config, "run-delete", deps),
    ).resolves.toMatchObject({ state: "succeeded", counts: { stale: 2 } });
    expect(deps.deleteExactIds).toHaveBeenCalledWith(
      [staged(10).id, staged(9).id].sort(),
    );
    expect(await store.manifest()).toHaveLength(8);
  });

  it.each([
    [600, 500, "succeeded"],
    [600, 499, "action_required"],
    [10, 8, "succeeded"],
    [10, 7, "action_required"],
  ] as const)(
    "applies exact deletion thresholds for %i managed and %i current records",
    async (managedCount, currentCount, state) => {
      const store = new MemoryReconciliationStore();
      const managed = Array.from({ length: managedCount }, (_, index) =>
        staged(index + 1),
      );
      const current = managed.slice(0, currentCount);
      for (const record of managed)
        store.manifestRecords.set(record.id, manifest(record));
      await admit(store, `run-threshold-${managedCount}-${currentCount}`);
      const deps = dependencies(
        current,
        managed.map((record) => record.destinationId),
      );

      const result = await reconcile(
        store,
        config,
        `run-threshold-${managedCount}-${currentCount}`,
        deps,
      );

      expect(result.state).toBe(state);
      expect(result.counts).toMatchObject({
        stale: managedCount - currentCount,
        plannedDeletions: managedCount - currentCount,
        ...(state === "action_required"
          ? { withheldDeletions: managedCount - currentCount }
          : { successfulDeletions: managedCount - currentCount }),
      });
      if (state === "action_required")
        expect(deps.deleteExactIds).not.toHaveBeenCalled();
      else expect(deps.deleteExactIds).toHaveBeenCalled();
    },
  );

  it("continues independent deletion batches and retries residuals", async () => {
    const store = new MemoryReconciliationStore();
    const managed = Array.from({ length: 3_000 }, (_, index) =>
      staged(index + 1),
    );
    const current = managed.slice(0, 2_499);
    for (const record of managed)
      store.manifestRecords.set(record.id, manifest(record));
    await admit(store, "run-partial-delete");
    const deps = dependencies(
      current,
      managed.map((record) => record.destinationId),
    );
    deps.deleteExactIds.mockRejectedValueOnce(new Error("synthetic delete"));

    const guarded = await reconcile(store, config, "run-partial-delete", deps);
    expect(guarded).toMatchObject({
      state: "action_required",
      counts: { plannedDeletions: 501, withheldDeletions: 501 },
    });
    await expect(
      confirmDeletion(
        store,
        config,
        guarded.deletionPlan!.id,
        guarded.deletionPlan!.fingerprint,
        deps,
      ),
    ).resolves.toMatchObject({
      state: "completed_with_errors",
      counts: { successfulDeletions: 1, failedDeletions: 500 },
    });
    expect(deps.deleteExactIds).toHaveBeenCalledTimes(2);
    expect(await store.manifest()).toHaveLength(2_999);

    await admit(store, "run-partial-delete-retry");
    const retry = dependencies(
      current,
      managed.slice(0, 2_999).map((record) => record.destinationId),
    );
    const retryPlan = await reconcile(
      store,
      config,
      "run-partial-delete-retry",
      retry,
    );
    expect(retryPlan).toMatchObject({
      state: "action_required",
      counts: { plannedDeletions: 500, withheldDeletions: 500 },
    });
    await expect(
      confirmDeletion(
        store,
        config,
        retryPlan.deletionPlan!.id,
        retryPlan.deletionPlan!.fingerprint,
        retry,
      ),
    ).resolves.toMatchObject({
      state: "succeeded",
      counts: { successfulDeletions: 500 },
    });
    expect(await store.manifest()).toHaveLength(2_499);
  });

  it("deletes a trusted persisted destination ID without broadening the delete boundary", async () => {
    const store = new MemoryReconciliationStore();
    const records = Array.from({ length: 6 }, (_, index) => staged(index + 1));
    const adopted = { ...manifest(records[0]!), destinationId: "adopted-1" };
    store.manifestRecords.set(adopted.destinationId, adopted);
    for (const record of records.slice(1))
      store.manifestRecords.set(record.id, manifest(record));
    await admit(store, "run-adopted-delete");
    const deps = dependencies(records.slice(1), [
      adopted.destinationId,
      ...records.slice(1).map((item) => item.id),
    ]);

    await expect(
      reconcile(store, config, "run-adopted-delete", deps),
    ).resolves.toMatchObject({
      state: "succeeded",
      counts: { plannedDeletions: 1, successfulDeletions: 1 },
    });
    expect(deps.deleteExactIds).toHaveBeenCalledWith(
      [adopted.destinationId],
      new Set([adopted.destinationId]),
    );
    expect(await store.manifest()).toHaveLength(5);
  });

  it("stores, confirms, and applies an unchanged exact guarded deletion plan", async () => {
    const store = new MemoryReconciliationStore();
    for (let id = 1; id <= 4; id += 1)
      store.manifestRecords.set(staged(id).id, manifest(staged(id)));
    await admit(store, "run-guard");
    const deps = dependencies([staged(1), staged(2), staged(3)]);
    const guarded = await reconcile(store, config, "run-guard", deps);

    expect(guarded).toMatchObject({
      state: "action_required",
      deletionPlan: { exactIds: [staged(4).id], state: "pending" },
    });
    expect(deps.verifyFields).toHaveBeenCalledWith(
      [staged(1), staged(2), staged(3)],
      expect.any(Function),
    );
    expect(deps.verify).not.toHaveBeenCalled();
    expect(deps.deleteExactIds).not.toHaveBeenCalled();
    const plan = guarded.deletionPlan!;
    await expect(
      confirmDeletion(store, config, plan.id, plan.fingerprint, deps),
    ).resolves.toMatchObject({ state: "succeeded" });
    expect(deps.deleteExactIds).toHaveBeenCalledWith([staged(4).id]);
    expect(deps.verify).toHaveBeenCalledWith(
      [staged(1), staged(2), staged(3)],
      expect.any(Function),
    );
    expect(store.activeRunId).toBeNull();
  });

  it("uses rebound persisted staging when a guarded run resumes", async () => {
    const store = new MemoryReconciliationStore();
    const records = await Promise.all(
      [1, 2, 3, 4].map(async (id) => {
        const generated = staged(id);
        const adopted = await prepareRecordForDestinationId(
          generated,
          `legacy-${id}`,
        );
        store.manifestRecords.set(`legacy-${id}`, {
          ...manifest(generated),
          destinationId: `legacy-${id}`,
          hash: adopted.hash,
        });
        return generated;
      }),
    );
    await admit(store, "run-adopted-guard");
    const current = records.slice(0, 3);
    const deps = dependencies(current, ["legacy-1", "legacy-2", "legacy-3"]);
    const guarded = await reconcile(store, config, "run-adopted-guard", deps);

    expect(guarded).toMatchObject({
      state: "action_required",
      deletionPlan: { exactIds: ["legacy-4"] },
    });
    await expect(
      confirmDeletion(
        store,
        config,
        guarded.deletionPlan!.id,
        guarded.deletionPlan!.fingerprint,
        deps,
      ),
    ).resolves.toMatchObject({ state: "succeeded" });
    expect(deps.verify).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ destinationId: "legacy-1" }),
        expect.objectContaining({ destinationId: "legacy-2" }),
        expect.objectContaining({ destinationId: "legacy-3" }),
      ]),
      expect.any(Function),
    );
  });

  it("restores quarantined ownership when a guarded run is confirmed after restart", async () => {
    const store = new MemoryReconciliationStore();
    for (let id = 1; id <= 4; id += 1)
      store.manifestRecords.set(staged(id).id, manifest(staged(id)));
    await admit(store, "run-guarded-degraded");
    const deps = dependencies([staged(1), staged(2)]);
    deps.enumerate = vi.fn(async (_locale, _checkpoint, report) => {
      report({
        id: staged(3).id,
        articleId: "3",
        locale: "en_us",
        publicTitle: "Public article 3",
        publicUrl: "https://example.zendesk.com/hc/en-us/articles/3",
        reasonCode: "INVALID_SOURCE_RECORD",
      });
      return [staged(1), staged(2)];
    });
    const guarded = await reconcile(
      store,
      config,
      "run-guarded-degraded",
      deps,
    );
    expect(guarded).toMatchObject({
      state: "action_required",
      counts: { quarantined: 1, stale: 1 },
    });

    const restarted = dependencies([]);
    await expect(
      confirmDeletion(
        store,
        config,
        guarded.deletionPlan!.id,
        guarded.deletionPlan!.fingerprint,
        restarted,
      ),
    ).resolves.toMatchObject({ state: "degraded" });
    expect(restarted.verify).toHaveBeenCalledWith(
      [staged(1), staged(2)],
      expect.any(Function),
      [staged(3).id],
    );
    expect(store.manifestRecords.has(staged(3).id)).toBe(true);
    expect(store.activeRunId).toBeNull();
  });

  it("cooperatively cancels inside field and owned-ID verification", async () => {
    for (const phase of ["fields", "ids"] as const) {
      const store = new MemoryReconciliationStore();
      await admit(store, `run-cancel-${phase}`);
      const deps = dependencies([staged(1)]);
      deps[phase === "fields" ? "verifyFields" : "verify"] = vi.fn(
        async (_records, checkpoint) => {
          await store.requestCancellation(`run-cancel-${phase}`);
          await checkpoint();
        },
      );

      await expect(
        reconcile(store, config, `run-cancel-${phase}`, deps),
      ).resolves.toMatchObject({ state: "canceled" });
      expect(store.activeRunId).toBeNull();
    }
  });

  it("rejects a wrong fingerprint and invalidates a plan after configuration changes", async () => {
    const store = new MemoryReconciliationStore();
    for (let id = 1; id <= 4; id += 1)
      store.manifestRecords.set(staged(id).id, manifest(staged(id)));
    await admit(store, "run-stale-plan");
    const deps = dependencies([staged(1), staged(2), staged(3)]);
    const plan = (await reconcile(store, config, "run-stale-plan", deps))
      .deletionPlan!;

    await expect(
      confirmDeletion(store, config, plan.id, "wrong", deps),
    ).rejects.toMatchObject({ code: "DELETION_PLAN_MISMATCH" });
    store.configRevision += 1;
    await expect(
      confirmDeletion(store, config, plan.id, plan.fingerprint, deps),
    ).rejects.toMatchObject({ code: "DELETION_PLAN_STALE" });
    expect((await store.deletionPlan(plan.id))?.state).toBe("invalidated");
    expect(deps.deleteExactIds).not.toHaveBeenCalled();
  });

  it("invalidates approval when relevant destination proof changes", async () => {
    const store = new MemoryReconciliationStore();
    for (let id = 1; id <= 4; id += 1)
      store.manifestRecords.set(staged(id).id, manifest(staged(id)));
    await admit(store, "run-destination-proof");
    const base = dependencies([staged(1), staged(2), staged(3)]);
    const destinationProof = vi
      .fn(async (ids: readonly string[], checkpoint: () => Promise<void>) => {
        void ids;
        void checkpoint;
        return "proof-1";
      })
      .mockResolvedValueOnce("proof-1")
      .mockResolvedValueOnce("proof-2");
    const deps = { ...base, destinationProof };
    const guarded = await reconcile(
      store,
      config,
      "run-destination-proof",
      deps,
    );

    await expect(
      confirmDeletion(
        store,
        config,
        guarded.deletionPlan!.id,
        guarded.deletionPlan!.fingerprint,
        deps,
      ),
    ).rejects.toMatchObject({ code: "DELETION_PLAN_STALE" });
    expect((await store.deletionPlan(guarded.deletionPlan!.id))?.state).toBe(
      "invalidated",
    );
    expect(await store.activeRun()).toBeNull();
    expect(base.deleteExactIds).not.toHaveBeenCalled();
  });

  it("cooperatively cancels inside source enumeration without destination mutation", async () => {
    const store = new MemoryReconciliationStore();
    const selectedConfig = { ...config, locales: ["en-US"] };
    await admit(store, "run-cancel", selectedConfig);
    const deps = dependencies([staged(1)]);
    deps.enumerate = vi.fn(async (_locale, checkpoint) => {
      await store.requestCancellation("run-cancel");
      await checkpoint();
      return [staged(1)];
    });

    await expect(
      reconcile(store, selectedConfig, "run-cancel", deps),
    ).resolves.toMatchObject({ state: "canceled" });
    expect(deps.upsert).not.toHaveBeenCalled();
    expect(deps.deleteExactIds).not.toHaveBeenCalled();
    expect(store.staging.has("run-cancel")).toBe(false);
  });

  it("fails incomplete enumeration without stale deletion and records a safe code", async () => {
    const store = new MemoryReconciliationStore();
    store.manifestRecords.set(staged(1).id, manifest(staged(1)));
    await admit(store, "run-failed-source");
    const deps = dependencies([]);
    deps.enumerate = vi.fn(async () => {
      throw new Error("private vendor response");
    });

    await expect(
      reconcile(store, config, "run-failed-source", deps),
    ).resolves.toMatchObject({ state: "failed" });
    expect(deps.deleteExactIds).not.toHaveBeenCalled();
    expect((await store.run("run-failed-source"))?.failureCode).toBe(
      "RECONCILIATION_FAILED",
    );
  });

  it("converges after one acknowledged batch is followed by a failed batch", async () => {
    const store = new MemoryReconciliationStore();
    const largeA = staged(1, "large-a", "a".repeat(1_100_000));
    const largeB = staged(2, "large-b", "b".repeat(1_100_000));
    await admit(store, "run-partial");
    const partial = dependencies([largeA, largeB]);
    partial.upsert
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("acknowledgement failed"));

    await expect(
      reconcile(store, config, "run-partial", partial),
    ).resolves.toMatchObject({ state: "failed" });
    expect(await store.manifest()).toHaveLength(1);

    await admit(store, "run-recovery");
    const recovery = dependencies([largeA, largeB], [largeA.id]);
    await expect(
      reconcile(store, config, "run-recovery", recovery),
    ).resolves.toMatchObject({
      state: "succeeded",
      counts: { created: 1, unchanged: 1 },
    });
    expect(recovery.upsert).toHaveBeenCalledOnce();
    expect(await store.manifest()).toHaveLength(2);
  });

  it("accepts a record that fits the SearchStax request limit", async () => {
    const store = new MemoryReconciliationStore();
    await admit(store, "run-large-record");
    const deps = dependencies([
      staged(1, "large-record", "a".repeat(1_950_000)),
    ]);

    await expect(
      reconcile(store, config, "run-large-record", deps),
    ).resolves.toMatchObject({ state: "succeeded", counts: { created: 1 } });
    expect(deps.upsert).toHaveBeenCalledOnce();
  });

  it("stops on hosted and local corpus ceilings before destination mutation", async () => {
    for (const [target, count] of [
      ["hosted", 501],
      ["local", 5_001],
    ] as const) {
      const store = new MemoryReconciliationStore();
      const selectedConfig = { ...config, target };
      await admit(store, `run-${target}`, selectedConfig);
      const deps = dependencies(
        Array.from({ length: count }, (_, index) => staged(index + 1)),
      );
      await expect(
        reconcile(store, selectedConfig, `run-${target}`, deps),
      ).resolves.toMatchObject({ state: "failed" });
      expect(deps.upsert).not.toHaveBeenCalled();
      expect((await store.run(`run-${target}`))?.failureCode).toBe(
        "CORPUS_LIMIT_EXCEEDED",
      );
    }
  });

  it("fails a configuration race after an acknowledged upsert without deleting stale records", async () => {
    const store = new MemoryReconciliationStore();
    for (let id = 1; id <= 10; id += 1)
      store.manifestRecords.set(staged(id).id, manifest(staged(id)));
    await admit(store, "run-race");
    const changed = staged(1, "new-hash");
    const deps = dependencies([
      changed,
      ...Array.from({ length: 7 }, (_, index) => staged(index + 2)),
    ]);
    deps.upsert = vi.fn(async () => {
      store.configRevision += 1;
    });

    await expect(
      reconcile(store, config, "run-race", deps),
    ).resolves.toMatchObject({ state: "failed" });
    expect(deps.deleteExactIds).not.toHaveBeenCalled();
    expect((await store.run("run-race"))?.failureCode).toBe(
      "CONFIGURATION_REVISION_MISMATCH",
    );
    expect(store.manifestRecords.get(changed.id)?.hash).toBe("new-hash");
  });

  it("rejects a concurrent run and recovers an abandoned terminal Workflow", async () => {
    const store = new MemoryReconciliationStore();
    await admit(store, "run-active");
    await expect(
      admitReconciliation(
        store,
        config,
        "run-rejected",
        "workflow-rejected",
        async () => false,
      ),
    ).resolves.toBe(false);

    store.staging.set("run-active", new Map([[staged(1).id, staged(1)]]));
    await expect(
      admitReconciliation(
        store,
        config,
        "run-replacement",
        "workflow-replacement",
        async () => true,
      ),
    ).resolves.toBe(true);
    expect((await store.run("run-active"))?.state).toBe("abandoned");
    expect(store.staging.has("run-active")).toBe(false);
    expect(store.activeRunId).toBe("run-replacement");
    expect((await store.run("run-replacement"))?.counts).toEqual(emptyCounts());
  });
});

describe("incremental article reconciliation", () => {
  it("upserts an eligible article once and suppresses duplicate delivery", async () => {
    const store = new MemoryReconciliationStore();
    const item = staged(1);
    const deps = dependencies([item]);
    await admit(store, "webhook-1");
    await expect(
      reconcileArticle(store, config, "webhook-1", "1", ["en-US"], deps),
    ).resolves.toMatchObject({ state: "succeeded", counts: { created: 1 } });
    await admit(store, "webhook-2");
    const replay = dependencies([item]);
    await expect(
      reconcileArticle(store, config, "webhook-2", "1", ["en-US"], replay),
    ).resolves.toMatchObject({ state: "succeeded", counts: { unchanged: 1 } });
    expect(deps.upsert).toHaveBeenCalledOnce();
    expect(replay.upsert).not.toHaveBeenCalled();
    expect(
      (await store.manifest()).map((record) => record.destinationId),
    ).toEqual([item.destinationId]);
  });

  it("removes only owned current destination state and makes duplicate unpublish harmless", async () => {
    const store = new MemoryReconciliationStore();
    const item = staged(1);
    const deps = dependencies([item]);
    await admit(store, "webhook-publish");
    await reconcileArticle(
      store,
      config,
      "webhook-publish",
      "1",
      ["en-US"],
      deps,
    );
    await admit(store, "webhook-unpublish");
    const unpublish = dependencies([], [item.destinationId]);
    await expect(
      reconcileArticle(
        store,
        config,
        "webhook-unpublish",
        "1",
        ["en-US"],
        unpublish,
      ),
    ).resolves.toMatchObject({ state: "succeeded", counts: { stale: 1 } });
    expect(unpublish.deleteExactIds).toHaveBeenCalledWith(
      [item.destinationId],
      undefined,
    );
    await admit(store, "webhook-unpublish-replay");
    const replay = dependencies([]);
    await expect(
      reconcileArticle(
        store,
        config,
        "webhook-unpublish-replay",
        "1",
        ["en-US"],
        replay,
      ),
    ).resolves.toMatchObject({ state: "succeeded" });
    expect(replay.deleteExactIds).not.toHaveBeenCalled();
  });

  it("preserves a manifest when the current destination is foreign", async () => {
    const store = new MemoryReconciliationStore();
    const item = staged(1);
    const deps = dependencies([item]);
    await admit(store, "webhook-publish-foreign");
    await reconcileArticle(
      store,
      config,
      "webhook-publish-foreign",
      "1",
      ["en-US"],
      deps,
    );
    await admit(store, "webhook-unpublish-foreign");
    const foreign = dependencies([], []);
    foreign.destinationDocument = vi.fn(async () => ({
      id: item.destinationId,
      connector_key_s: "other-connector",
    }));
    await expect(
      reconcileArticle(
        store,
        config,
        "webhook-unpublish-foreign",
        "1",
        ["en-US"],
        foreign,
      ),
    ).resolves.toMatchObject({
      state: "completed_with_errors",
      counts: { failedDeletions: 1 },
    });
    expect(foreign.deleteExactIds).not.toHaveBeenCalled();
    expect(await store.manifest()).toHaveLength(1);
  });
});
