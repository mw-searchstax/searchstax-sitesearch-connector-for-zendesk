import { describe, expect, it, vi } from "vitest";

import { ApiError, createApiHandler } from "./router.ts";
import type { ApplicationService, SafeScheduler, SafeSetup } from "./types.ts";
import { ContractError } from "../contracts/shared.ts";

const safeSetup: SafeSetup = {
  configured: false,
  state: "unconfigured",
  zendeskConfigured: false,
  searchstaxConfigured: false,
};

const safeScheduler: SafeScheduler = {
  state: "disabled",
  retryAttempt: 0,
};

function service(): ApplicationService {
  return {
    setup: vi.fn(async () => safeSetup),
    validateZendesk: vi.fn(async () => ({ brands: [], locales: [] })),
    checkSearchStaxConnection: async () => undefined,
    retrySetup: async () => {
      throw new Error("Unused fixture");
    },
    validateSearchStax: vi.fn(async () => undefined),
    readinessStatus: vi.fn(async () => null),
    completeSetup: vi.fn(async () => safeSetup),
    planRecovery: vi.fn(async () => ({
      recordCount: 1,
      fingerprint: "fingerprint",
    })),
    applyRecovery: vi.fn(async () => safeSetup),
    replaceZendesk: vi.fn(async () => safeSetup),
    replaceSearchStax: vi.fn(async () => safeSetup),
    dashboard: vi.fn(async () => ({
      setup: safeSetup,
      manifestCounts: [],
      activeRun: null,
      scheduler: safeScheduler,
      issues: [],
      incidents: [],
    })),
    setScheduler: vi.fn(async (enabled): Promise<SafeScheduler> => ({
      ...safeScheduler,
      state: enabled ? "enabled" : "paused",
      ...(enabled ? {} : { pauseReason: "operator" as const }),
    })),
    runs: vi.fn(async () => ({ runs: [] })),
    startRun: vi.fn(async () => ({ runId: "run-1" })),
    existingIndexDryRun: vi.fn(async () => ({
      readOnly: true as const,
      fingerprint: "fingerprint",
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
    })),
    existingIndexApply: vi.fn(async (fingerprint, legacyIngestionPaused) => ({
      status: "applied" as const,
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
        ambiguousUnmatched: legacyIngestionPaused ? 0 : 1,
      },
      unresolvedResiduals: [],
      finalVerification: "passed" as const,
    })),
    cancelRun: vi.fn(async () => undefined),
    planLocales: vi.fn(async (locales) => ({
      id: "plan-1",
      locales,
      removedRecordCount: 0,
      fingerprint: "fingerprint",
    })),
    applyLocales: vi.fn(async () => safeSetup),
    deletionPlan: vi.fn(async (id) => ({
      id,
      runId: "run-1",
      staleCount: 2,
      exactIds: [],
      state: "pending",
      fingerprint: "fingerprint",
    })),
    confirmDeletion: vi.fn(async () => undefined),
  };
}

function mutation(path: string, body = "{}", headers: HeadersInit = {}) {
  return new Request(`https://connector.example${path}`, {
    method: "POST",
    headers: {
      origin: "https://connector.example",
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

describe("operator API router", () => {
  it("routes signed webhook requests without browser-origin requirements", async () => {
    const fake = service();
    fake.webhookStatus = () => ({
      enabled: true,
      endpoint: "/api/webhooks/zendesk",
      requiresHttps: true,
      signingSecretConfigured: true,
    });
    fake.receiveZendeskWebhook = vi.fn(
      async (raw, signature, timestamp, secure) => {
        expect(raw).toBe('{"event":"signed"}');
        expect(signature).toBe("signature");
        expect(timestamp).toBe("timestamp");
        expect(secure).toBe(true);
        return { accepted: true, runId: "run-webhook" };
      },
    );
    const handler = createApiHandler(fake);
    await expect(
      handler(
        new Request("https://connector.example/api/webhooks/zendesk/status"),
      ),
    ).resolves.toMatchObject({ status: 200 });
    const response = await handler(
      new Request("https://connector.example/api/webhooks/zendesk", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zendesk-webhook-signature": "signature",
          "x-zendesk-webhook-signature-timestamp": "timestamp",
        },
        body: '{"event":"signed"}',
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      runId: "run-webhook",
    });
  });

  it("returns only the safe setup projection", async () => {
    const response = await createApiHandler(service())(
      new Request("https://connector.example/api/setup"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(safeSetup);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects cross-origin mutations before calling the service", async () => {
    const fake = service();
    const response = await createApiHandler(fake)(
      new Request("https://connector.example/api/runs", {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
    expect(fake.startRun).not.toHaveBeenCalled();
  });

  it("requires strict JSON and bounded bodies", async () => {
    const fake = service();
    const wrongType = await createApiHandler(fake)(
      mutation("/api/runs", "{}", { "content-type": "text/plain" }),
    );
    const oversized = await createApiHandler(fake)(
      mutation("/api/runs", JSON.stringify({ value: "x".repeat(33 * 1024) })),
    );
    expect(wrongType.status).toBe(415);
    expect(oversized.status).toBe(413);
  });

  it("starts and cancels one manual run", async () => {
    const fake = service();
    const handler = createApiHandler(fake);
    expect((await handler(mutation("/api/runs"))).status).toBe(202);
    expect((await handler(mutation("/api/runs/run-1/cancel"))).status).toBe(
      202,
    );
    expect(fake.cancelRun).toHaveBeenCalledWith("run-1");
  });

  it("accepts the exact scheduler mutation body", async () => {
    const fake = service();
    const response = await createApiHandler(fake)(
      new Request("https://connector.example/api/scheduler", {
        method: "PUT",
        headers: {
          origin: "https://connector.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "enabled",
      retryAttempt: 0,
    });
    expect(fake.setScheduler).toHaveBeenCalledWith(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects missing, wrong, and extra scheduler fields", async () => {
    const fake = service();
    const handler = createApiHandler(fake);
    for (const value of [{}, { enabled: "yes" }, { enabled: true, extra: 1 }]) {
      const response = await handler(
        new Request("https://connector.example/api/scheduler", {
          method: "PUT",
          headers: {
            origin: "https://connector.example",
            "content-type": "application/json",
          },
          body: JSON.stringify(value),
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "INVALID_INPUT",
          message: "Scheduler input was invalid.",
        },
      });
    }
    expect(fake.setScheduler).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin scheduler mutation", async () => {
    const fake = service();
    const response = await createApiHandler(fake)(
      new Request("https://connector.example/api/scheduler", {
        method: "PUT",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "ORIGIN_REJECTED",
        message: "Request origin was rejected.",
      },
    });
    expect(fake.setScheduler).not.toHaveBeenCalled();
  });

  it("passes only the exact deletion-plan confirmation", async () => {
    const fake = service();
    const response = await createApiHandler(fake)(
      mutation(
        "/api/deletion-plans/plan-1/confirm",
        JSON.stringify({ fingerprint: "fingerprint" }),
      ),
    );
    expect(response.status).toBe(202);
    expect(fake.confirmDeletion).toHaveBeenCalledWith("plan-1", "fingerprint");
  });

  it("routes the explicit existing-index dry run without adding apply controls", async () => {
    const fake = service();
    const response = await createApiHandler(fake)(
      mutation("/api/existing-index/dry-run", "{}"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ readOnly: true });
    expect(fake.existingIndexDryRun).toHaveBeenCalledTimes(1);
  });

  it("routes only the reviewed fingerprint and explicit legacy-ingestion confirmation", async () => {
    const fake = service();
    const response = await createApiHandler(fake)(
      mutation(
        "/api/existing-index/apply",
        JSON.stringify({
          fingerprint: "fingerprint",
          legacyIngestionPaused: true,
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(fake.existingIndexApply).toHaveBeenCalledWith("fingerprint", true);
  });

  it("rejects apply without explicit pause confirmation or with extra mutation input", async () => {
    const fake = service();
    const handler = createApiHandler(fake);
    const notPaused = await handler(
      mutation(
        "/api/existing-index/apply",
        JSON.stringify({
          fingerprint: "fingerprint",
          legacyIngestionPaused: false,
        }),
      ),
    );
    const extra = await handler(
      mutation(
        "/api/existing-index/apply",
        JSON.stringify({
          fingerprint: "fingerprint",
          legacyIngestionPaused: true,
          actions: [],
        }),
      ),
    );
    expect(notPaused.status).toBe(409);
    expect(extra.status).toBe(400);
    expect(fake.existingIndexApply).not.toHaveBeenCalled();
  });

  it("routes credential replacement and exact locale plans", async () => {
    const fake = service();
    const handler = createApiHandler(fake);
    const replacement = new Request(
      "https://connector.example/api/credentials/zendesk",
      {
        method: "PUT",
        headers: {
          origin: "https://connector.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accountSubdomain: "example",
          email: "operator@example.com",
          apiToken: "write-only",
        }),
      },
    );
    const plan = await handler(
      mutation("/api/locales/plan", JSON.stringify({ locales: ["en-us"] })),
    );
    const apply = await handler(
      mutation(
        "/api/locales/apply",
        JSON.stringify({ planId: "plan-1", fingerprint: "fingerprint" }),
      ),
    );
    expect((await handler(replacement)).status).toBe(200);
    expect(plan.status).toBe(200);
    expect(apply.status).toBe(200);
    expect(fake.planLocales).toHaveBeenCalledWith(["en-us"]);
    expect(fake.applyLocales).toHaveBeenCalledWith("plan-1", "fingerprint");
  });

  it("does not accept the execution target from browser setup input", async () => {
    const fake = service();
    const response = await createApiHandler(fake)(
      mutation(
        "/api/setup/complete",
        JSON.stringify({
          accountSubdomain: "example",
          email: "operator@example.com",
          apiToken: "write-only",
          brandId: "brand-1",
          locales: ["en-us"],
          connectorKey: "hosted-poc",
          updateEndpoint: "https://example.com/update",
          selectEndpoint: "https://example.com/select",
          token: "write-only",
          destinationName: "POC index",
          executionTarget: "local",
        }),
      ),
    );

    expect(response.status).toBe(201);
    expect(fake.completeSetup).toHaveBeenCalledWith({
      accountSubdomain: "example",
      email: "operator@example.com",
      apiToken: "write-only",
      brandId: "brand-1",
      locales: ["en-us"],
      connectorKey: "hosted-poc",
      updateEndpoint: "https://example.com/update",
      selectEndpoint: "https://example.com/select",
      token: "write-only",
      destinationName: "POC index",
    });
  });

  it("routes explicit namespace recovery planning and confirmation", async () => {
    const fake = service();
    const input = {
      accountSubdomain: "example",
      email: "operator@example.com",
      apiToken: "write-only",
      brandId: "brand-1",
      locales: ["en-us"],
      connectorKey: "connector",
      updateEndpoint: "https://example.com/update",
      selectEndpoint: "https://example.com/select",
      token: "write-only",
      destinationName: "Recovered index",
    };
    const handler = createApiHandler(fake);
    const planned = await handler(
      mutation("/api/recovery/plan", JSON.stringify(input)),
    );
    const applied = await handler(
      mutation(
        "/api/recovery/apply",
        JSON.stringify({ ...input, fingerprint: "fingerprint" }),
      ),
    );

    expect(planned.status).toBe(200);
    expect(applied.status).toBe(201);
    expect(fake.planRecovery).toHaveBeenCalledWith(input);
    expect(fake.applyRecovery).toHaveBeenCalledWith(input, "fingerprint");
  });

  it("returns stable safe errors without leaking thrown details", async () => {
    const fake = service();
    vi.mocked(fake.startRun).mockRejectedValue(
      new Error("secret vendor response"),
    );
    const unknown = await createApiHandler(fake)(mutation("/api/runs"));
    vi.mocked(fake.startRun).mockRejectedValue(
      new ApiError(409, "RUN_ACTIVE", "A reconciliation is already active."),
    );
    const known = await createApiHandler(fake)(mutation("/api/runs"));
    expect(await unknown.text()).not.toContain("secret vendor response");
    expect(known.status).toBe(409);
    expect(await known.json()).toEqual({
      error: {
        code: "RUN_ACTIVE",
        message: "A reconciliation is already active.",
      },
    });
  });

  it("preserves safe contract failures for adjacent form errors", async () => {
    const fake = service();
    vi.mocked(fake.validateZendesk).mockRejectedValue(
      new ContractError("PERMANENT_HTTP_FAILURE", "Zendesk request failed."),
    );
    const response = await createApiHandler(fake)(
      mutation(
        "/api/setup/zendesk/validate",
        JSON.stringify({
          accountSubdomain: "bad",
          email: "bad",
          apiToken: "bad",
        }),
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "PERMANENT_HTTP_FAILURE",
        message: "Zendesk request failed.",
      },
    });
  });

  it("returns a conflict for a stale locale plan", async () => {
    const fake = service();
    vi.mocked(fake.applyLocales).mockRejectedValue(
      new ApiError(
        409,
        "STALE_LOCALE_PLAN",
        "Configuration changed after this plan was created.",
      ),
    );
    const response = await createApiHandler(fake)(
      mutation(
        "/api/locales/apply",
        JSON.stringify({ planId: "plan-1", fingerprint: "old" }),
      ),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "STALE_LOCALE_PLAN",
        message: "Configuration changed after this plan was created.",
      },
    });
  });
});
