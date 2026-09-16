import { describe, expect, it, vi } from "vitest";

import {
  admitReconciliation,
  confirmDeletion,
  reconcile,
  type ReconciliationDependencies,
} from "./engine.ts";
import { MemoryReconciliationStore } from "./memory-store.ts";
import type { ReconciliationConfig, StagedRecord } from "./model.ts";

const config: ReconciliationConfig = {
  revision: 1,
  connectorKey: "hardening",
  zendeskSubdomain: "example",
  locales: ["en-US"],
  target: "local",
};

function record(id = 1): StagedRecord {
  const stableId = `zdg_hardening_${id}_en_us`;
  const document = { id: stableId, body_text_txt_en: `Body ${id}` };
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
    sourceUpdatedAt: "2026-08-09T00:00:00.000Z",
    document,
    canonical,
    hash: `hash-${id}`,
    byteSize: new TextEncoder().encode(canonical).byteLength,
    warnings: [],
  };
}

async function admit(store: MemoryReconciliationStore, runId: string) {
  await expect(
    admitReconciliation(
      store,
      config,
      runId,
      `workflow-${runId}`,
      async () => false,
    ),
  ).resolves.toBe(true);
}

function dependencies(
  records: readonly StagedRecord[],
  destination: Set<string>,
): ReconciliationDependencies & { upsert: ReturnType<typeof vi.fn> } {
  return {
    enumerate: vi.fn(async () => records),
    upsert: vi.fn(async (batch: readonly StagedRecord[]) => {
      for (const item of batch) destination.add(item.id);
    }),
    deleteExactIds: vi.fn(async (ids: readonly string[]) => {
      for (const id of ids) destination.delete(id);
    }),
    destinationIds: vi.fn(async () => [...destination]),
    verifyFields: vi.fn(async (checked: readonly StagedRecord[]) => {
      expect(checked.every((item) => destination.has(item.id))).toBe(true);
    }),
    verify: vi.fn(
      async (
        expected: readonly StagedRecord[],
        _checkpoint: () => Promise<void>,
        preservedIds: readonly string[] = [],
        optionalIds: readonly string[] = [],
      ) => {
        const required = new Set([
          ...expected.map((item) => item.id),
          ...preservedIds,
        ]);
        expect([...required].every((id) => destination.has(id))).toBe(true);
        expect(
          [...destination].every(
            (id) => required.has(id) || optionalIds.includes(id),
          ),
        ).toBe(true);
      },
    ),
    now: () => "2026-08-09T00:00:00.000Z",
    randomId: () => "hardening-plan",
  };
}

class AcknowledgementFaultStore extends MemoryReconciliationStore {
  private faultArmed = true;

  constructor(private readonly timing: "before" | "after") {
    super();
  }

  override async acknowledge(
    runId: string,
    records: readonly StagedRecord[],
    acknowledgedAt: string,
  ) {
    if (this.faultArmed && this.timing === "before") {
      this.faultArmed = false;
      throw new Error("synthetic pre-manifest fault");
    }
    await super.acknowledge(runId, records, acknowledgedAt);
    if (this.faultArmed) {
      this.faultArmed = false;
      throw new Error("synthetic post-manifest fault");
    }
  }
}

class RemovalFaultStore extends MemoryReconciliationStore {
  private faultArmed = true;

  constructor(private readonly timing: "before" | "after") {
    super();
  }

  override async removeManifest(ids: readonly string[]) {
    if (this.faultArmed && this.timing === "before") {
      this.faultArmed = false;
      throw new Error("synthetic pre-removal fault");
    }
    await super.removeManifest(ids);
    if (this.faultArmed) {
      this.faultArmed = false;
      throw new Error("synthetic post-removal fault");
    }
  }
}

class ConfirmationFaultStore extends MemoryReconciliationStore {
  private faultArmed = true;

  constructor(private readonly timing: "before" | "after") {
    super();
  }

  override async updateDeletionPlan(
    planId: string,
    state: "pending" | "confirmed" | "invalidated" | "applied",
  ) {
    if (this.faultArmed && state === "confirmed" && this.timing === "before") {
      this.faultArmed = false;
      throw new Error("synthetic pre-confirmation fault");
    }
    await super.updateDeletionPlan(planId, state);
    if (this.faultArmed && state === "confirmed") {
      this.faultArmed = false;
      throw new Error("synthetic post-confirmation fault");
    }
  }
}

async function seedOwnership(
  store: MemoryReconciliationStore,
  records: readonly StagedRecord[],
) {
  await store.acknowledge("seed", records, "2026-08-08T00:00:00.000Z");
}

describe("R05 irreversible-boundary hardening", () => {
  it.each(["before", "after"] as const)(
    "converges after failure %s destination upsert acknowledgement",
    async (timing) => {
      const store = new MemoryReconciliationStore();
      const destination = new Set<string>();
      const item = record();
      await admit(store, `run-${timing}`);
      const interrupted = dependencies([item], destination);
      interrupted.upsert = vi.fn(async (batch: readonly StagedRecord[]) => {
        if (timing === "before") throw new Error("synthetic pre-ack fault");
        for (const value of batch) destination.add(value.id);
        throw new Error("synthetic lost acknowledgement");
      });

      await expect(
        reconcile(store, config, `run-${timing}`, interrupted),
      ).resolves.toMatchObject({ state: "failed" });
      await expect(store.manifest()).resolves.toEqual([]);
      expect([...destination]).toEqual(timing === "after" ? [item.id] : []);

      await admit(store, `retry-${timing}`);
      const retry = dependencies([item], destination);
      await expect(
        reconcile(store, config, `retry-${timing}`, retry),
      ).resolves.toMatchObject({
        state: "succeeded",
        counts: { created: 1 },
      });
      expect(retry.upsert).toHaveBeenCalledOnce();
      await expect(store.manifest()).resolves.toEqual([
        expect.objectContaining({
          destinationId: item.destinationId,
          hash: item.hash,
        }),
      ]);
      expect([...destination]).toEqual([item.id]);
    },
  );

  it.each(["before", "after"] as const)(
    "converges after failure %s manifest acknowledgement",
    async (timing) => {
      const store = new AcknowledgementFaultStore(timing);
      const destination = new Set<string>();
      const item = record();
      await admit(store, `run-manifest-${timing}`);

      await expect(
        reconcile(
          store,
          config,
          `run-manifest-${timing}`,
          dependencies([item], destination),
        ),
      ).resolves.toMatchObject({ state: "failed" });
      await expect(store.manifest()).resolves.toHaveLength(
        timing === "after" ? 1 : 0,
      );
      expect([...destination]).toEqual([item.id]);

      await admit(store, `retry-manifest-${timing}`);
      const retry = dependencies([item], destination);
      await expect(
        reconcile(store, config, `retry-manifest-${timing}`, retry),
      ).resolves.toMatchObject({
        state: "succeeded",
        counts: timing === "after" ? { unchanged: 1 } : { created: 1 },
      });
      expect(retry.upsert).toHaveBeenCalledTimes(timing === "after" ? 0 : 1);
      await expect(store.manifest()).resolves.toEqual([
        expect.objectContaining({
          destinationId: item.destinationId,
          hash: item.hash,
        }),
      ]);
    },
  );

  it.each(["before", "after"] as const)(
    "converges after failure %s destination delete acknowledgement",
    async (timing) => {
      const store = new MemoryReconciliationStore();
      const owned = Array.from({ length: 5 }, (_, index) => record(index + 1));
      const retained = owned.slice(0, 4);
      const stale = owned[4]!;
      const destination = new Set(owned.map((item) => item.id));
      await seedOwnership(store, owned);
      await admit(store, `run-delete-${timing}`);
      const interrupted = dependencies(retained, destination);
      interrupted.deleteExactIds = vi.fn(async (ids: readonly string[]) => {
        expect(ids).toEqual([stale.id]);
        if (timing === "before") throw new Error("synthetic pre-delete fault");
        for (const id of ids) destination.delete(id);
        throw new Error("synthetic lost delete acknowledgement");
      });

      await expect(
        reconcile(store, config, `run-delete-${timing}`, interrupted),
      ).resolves.toMatchObject({
        state: "completed_with_errors",
        counts: { stale: 1, failedDeletions: 1 },
      });
      await expect(store.manifest()).resolves.toHaveLength(5);
      expect(destination.has(stale.id)).toBe(timing === "before");

      await admit(store, `retry-delete-${timing}`);
      const retry = dependencies(retained, destination);
      await expect(
        reconcile(store, config, `retry-delete-${timing}`, retry),
      ).resolves.toMatchObject({ state: "succeeded", counts: { stale: 1 } });
      expect(retry.deleteExactIds).toHaveBeenCalledWith([stale.id]);
      await expect(store.manifest()).resolves.toHaveLength(4);
      expect([...destination].sort()).toEqual(
        retained.map((item) => item.id).sort(),
      );
    },
  );

  it.each(["before", "after"] as const)(
    "converges after failure %s exact manifest removal",
    async (timing) => {
      const store = new RemovalFaultStore(timing);
      const owned = Array.from({ length: 5 }, (_, index) => record(index + 1));
      const retained = owned.slice(0, 4);
      const stale = owned[4]!;
      const destination = new Set(owned.map((item) => item.id));
      await seedOwnership(store, owned);
      await admit(store, `run-removal-${timing}`);

      await expect(
        reconcile(
          store,
          config,
          `run-removal-${timing}`,
          dependencies(retained, destination),
        ),
      ).resolves.toMatchObject({ state: "failed" });
      expect(destination.has(stale.id)).toBe(false);
      await expect(store.manifest()).resolves.toHaveLength(
        timing === "after" ? 4 : 5,
      );

      await admit(store, `retry-removal-${timing}`);
      const retry = dependencies(retained, destination);
      await expect(
        reconcile(store, config, `retry-removal-${timing}`, retry),
      ).resolves.toMatchObject({
        state: "succeeded",
        counts: { stale: timing === "after" ? 0 : 1 },
      });
      expect(retry.deleteExactIds).toHaveBeenCalledTimes(
        timing === "after" ? 0 : 1,
      );
      await expect(store.manifest()).resolves.toHaveLength(4);
      expect([...destination].sort()).toEqual(
        retained.map((item) => item.id).sort(),
      );
    },
  );

  it.each(["before", "after"] as const)(
    "recovers without deletion after failure %s guarded confirmation",
    async (timing) => {
      const store = new ConfirmationFaultStore(timing);
      const owned = Array.from({ length: 5 }, (_, index) => record(index + 1));
      const retained = owned.slice(0, 3);
      const staleIds = owned.slice(3).map((item) => item.id);
      const destination = new Set(owned.map((item) => item.id));
      await seedOwnership(store, owned);
      await admit(store, `run-confirm-${timing}`);
      const deps = dependencies(retained, destination);
      const guarded = await reconcile(
        store,
        config,
        `run-confirm-${timing}`,
        deps,
      );
      expect(guarded).toMatchObject({ state: "action_required" });

      await expect(
        confirmDeletion(
          store,
          config,
          guarded.deletionPlan!.id,
          guarded.deletionPlan!.fingerprint,
          deps,
        ),
      ).rejects.toThrow(/synthetic/u);
      expect(deps.deleteExactIds).not.toHaveBeenCalled();
      expect([...destination].sort()).toEqual(owned.map((item) => item.id));

      if (timing === "after") {
        await store.requestCancellation(`run-confirm-${timing}`);
        await store.finish(`run-confirm-${timing}`, "canceled");
        await admit(store, `retry-confirm-${timing}`);
        const replanned = await reconcile(
          store,
          config,
          `retry-confirm-${timing}`,
          deps,
        );
        expect(replanned).toMatchObject({ state: "action_required" });
        await expect(
          confirmDeletion(
            store,
            config,
            replanned.deletionPlan!.id,
            replanned.deletionPlan!.fingerprint,
            deps,
          ),
        ).resolves.toMatchObject({ state: "succeeded" });
      } else {
        await expect(
          confirmDeletion(
            store,
            config,
            guarded.deletionPlan!.id,
            guarded.deletionPlan!.fingerprint,
            deps,
          ),
        ).resolves.toMatchObject({ state: "succeeded" });
      }
      expect(deps.deleteExactIds).toHaveBeenCalledWith(staleIds);
      expect([...destination].sort()).toEqual(
        retained.map((item) => item.id).sort(),
      );
      await expect(store.manifest()).resolves.toHaveLength(3);
    },
  );
});
