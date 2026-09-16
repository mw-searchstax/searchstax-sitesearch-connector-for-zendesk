import { describe, expect, it, vi } from "vitest";

import { admitReconciliation, reconcile } from "./engine.ts";
import { MemoryReconciliationStore } from "./memory-store.ts";
import type { ReconciliationConfig, StagedRecord } from "./model.ts";

function fixtures(count: number): StagedRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const id = `zdg_scale_${number}_en_us`;
    const document = {
      id,
      connector_key_s: "scale",
      locale_s: "en-us",
      title_t_en: `Generated article ${number}`,
      body_text_txt_en: `Controlled fixture body ${number}`,
    };
    const canonical = JSON.stringify(document);
    return {
      id,
      destinationId: id,
      sourceIdentity: {
        subdomain: "example",
        articleId: String(number),
        locale: "en_us",
      },
      articleId: String(number),
      translationId: String(number + 10_000),
      locale: "en-us",
      sourceUpdatedAt: "2026-08-02T12:00:00.000Z",
      document,
      canonical,
      hash: `fixture-hash-${number}`,
      byteSize: new TextEncoder().encode(canonical).byteLength,
      warnings: [],
    };
  });
}

describe("P05 controlled fixture targets", () => {
  it.each([
    ["hosted", 500],
    ["local", 5_000],
  ] as const)(
    "reconciles the %s target of %i records",
    async (target, count) => {
      const records = fixtures(count);
      const totalBytes = records.reduce(
        (total, record) => total + record.byteSize,
        0,
      );
      const config: ReconciliationConfig = {
        revision: 1,
        connectorKey: "scale",
        zendeskSubdomain: "example",
        locales: ["en-US"],
        target,
      };
      const store = new MemoryReconciliationStore();
      await expect(
        admitReconciliation(
          store,
          config,
          `run-${target}`,
          `workflow-${target}`,
          async () => false,
        ),
      ).resolves.toBe(true);
      const upsert = vi.fn(async () => undefined);
      await expect(
        reconcile(store, config, `run-${target}`, {
          enumerate: vi.fn(async () => records),
          upsert,
          deleteExactIds: vi.fn(async () => undefined),
          destinationIds: vi.fn(async () => records.map((record) => record.id)),
          verifyFields: vi.fn(async () => undefined),
          verify: vi.fn(async () => undefined),
          now: () => "2026-08-02T12:00:00.000Z",
        }),
      ).resolves.toMatchObject({
        state: "succeeded",
        counts: { source: count, created: count, unchanged: 0, stale: 0 },
      });
      expect(store.manifestRecords.size).toBe(count);
      expect(totalBytes).toBeGreaterThan(count);
      expect(upsert).toHaveBeenCalled();
    },
    30_000,
  );
});
