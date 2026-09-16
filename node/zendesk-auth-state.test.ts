import { describe, expect, it, vi } from "vitest";

import {
  decryptConfiguration,
  encryptConfiguration,
} from "../worker/reconciliation/crypto.ts";
import type {
  ApplicationStateStore,
  StoredConfiguration,
  StoredScheduler,
} from "./application-state.ts";
import { CredentialCoordinator } from "./zendesk-auth-state.ts";
import type { OAuthTokens } from "./zendesk-oauth.ts";

const KEY = btoa("01234567890123456789012345678901");
const WRONG_KEY = btoa("abcdefghijklmnopqrstuvwxyz123456");
const NOW = 1_000_000;

function token(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    kind: "oauth",
    accountSubdomain: "account",
    clientId: "client",
    accessToken: "access-old",
    refreshToken: "refresh-old",
    accessExpiresAt: NOW + 600_000,
    refreshExpiresAt: NOW + 3_600_000,
    generation: 1,
    scopes: ["brands:read", "hc:read"],
    ...overrides,
  };
}

interface Fixture {
  store: ApplicationStateStore;
  configuration: StoredConfiguration;
  scheduler: StoredScheduler;
  compareAndSwap: ReturnType<typeof vi.fn>;
  saveScheduler: ReturnType<typeof vi.fn>;
}

async function fixture(
  credentials: OAuthTokens = token(),
  options: {
    revision?: number;
    schedulerState?: StoredScheduler["state"];
  } = {},
): Promise<Fixture> {
  const credentialEnvelope = JSON.stringify(
    await encryptConfiguration({ zendesk: credentials, searchstax: {} }, KEY),
  );
  const configuration: StoredConfiguration = {
    revision: options.revision ?? 7,
    state: "ready",
    connectorKey: "docs",
    brandId: "10",
    brandName: "Docs",
    brandSubdomain: "docs",
    selectedLocales: ["en-US"],
    destinationName: "Search",
    target: "local",
    credentialEnvelope,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };
  const scheduler: StoredScheduler = {
    state: options.schedulerState ?? "enabled",
    retryAttempt: 0,
    updatedAt: "2025-01-01T00:00:00Z",
  };
  const compareAndSwap = vi.fn(
    async (
      expectedRevision: number,
      expectedEnvelope: string,
      next: string,
    ) => {
      if (
        expectedRevision !== configuration.revision ||
        expectedEnvelope !== configuration.credentialEnvelope
      )
        return false;
      configuration.credentialEnvelope = next;
      return true;
    },
  );
  const saveScheduler = vi.fn(
    async (next: Omit<StoredScheduler, "updatedAt">) => {
      Object.assign(scheduler, next, { updatedAt: "2025-01-02T00:00:00Z" });
      return scheduler;
    },
  );
  const store = {
    configuration: async () => configuration,
    compareAndSwapCredentials: compareAndSwap,
    scheduler: async () => scheduler,
    saveScheduler,
  } as unknown as ApplicationStateStore;
  return { store, configuration, scheduler, compareAndSwap, saveScheduler };
}

function transport(
  refresh: (value: OAuthTokens) => Promise<OAuthTokens> | OAuthTokens,
) {
  return {
    settings: {
      clientId: "client",
      redirectUri: "http://127.0.0.1:43123/callback",
    },
    refresh: vi.fn(refresh),
  } as never;
}

describe("Zendesk credential coordinator", () => {
  it("returns a fresh token without calling the refresh transport", async () => {
    const state = await fixture();
    const refresh = vi.fn();
    const coordinator = new CredentialCoordinator(
      state.store,
      KEY,
      transport(refresh),
      () => NOW,
    );

    await expect(coordinator.provider("account", 7).get()).resolves.toBe(
      "Bearer access-old",
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(state.compareAndSwap).not.toHaveBeenCalled();
  });

  it("serializes concurrent unauthorized callbacks into one refresh", async () => {
    const state = await fixture(token({ accessExpiresAt: NOW + 30_000 }));
    let release!: (value: OAuthTokens) => void;
    const refreshed = token({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      accessExpiresAt: NOW + 600_000,
      generation: 2,
    });
    const refresh = vi.fn(
      () => new Promise<OAuthTokens>((resolve) => (release = resolve)),
    );
    const coordinator = new CredentialCoordinator(
      state.store,
      KEY,
      transport(refresh),
      () => NOW,
    );
    const provider = coordinator.provider("account", 7);
    const first = provider.onUnauthorized("Bearer access-old");
    const second = provider.onUnauthorized("Bearer access-old");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    release(refreshed);

    await expect(Promise.all([first, second])).resolves.toEqual([
      "Bearer access-new",
      "Bearer access-new",
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(state.compareAndSwap).toHaveBeenCalledTimes(1);
  });

  it("uses the current generation when a stale 401 arrives after another rotation", async () => {
    const current = token({
      accessToken: "access-current",
      refreshToken: "refresh-current",
      generation: 2,
    });
    const state = await fixture(current);
    const refresh = vi.fn();
    const coordinator = new CredentialCoordinator(
      state.store,
      KEY,
      transport(refresh),
      () => NOW,
    );

    await expect(
      coordinator.provider("account", 7).onUnauthorized("Bearer access-old"),
    ).resolves.toBe("Bearer access-current");
    expect(refresh).not.toHaveBeenCalled();
    expect(state.compareAndSwap).not.toHaveBeenCalled();
  });

  it("preserves the configuration revision while atomically saving the rotated pair", async () => {
    const state = await fixture(token({ accessExpiresAt: NOW + 30_000 }));
    const refreshed = token({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      accessExpiresAt: NOW + 600_000,
      generation: 2,
    });
    const coordinator = new CredentialCoordinator(
      state.store,
      KEY,
      transport(async () => refreshed),
      () => NOW,
    );

    await expect(
      coordinator.provider("account", 7).onUnauthorized("Bearer access-old"),
    ).resolves.toBe("Bearer access-new");
    expect(state.configuration.revision).toBe(7);
    expect(state.compareAndSwap).toHaveBeenCalledWith(
      7,
      expect.any(String),
      expect.any(String),
    );
    const saved = await decryptConfiguration<{ zendesk: OAuthTokens }>(
      JSON.parse(state.configuration.credentialEnvelope),
      KEY,
    );
    expect(saved.zendesk).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      generation: 2,
    });
  });

  it("rejects a configuration revision change before reading or refreshing credentials", async () => {
    const state = await fixture(token(), { revision: 8 });
    const refresh = vi.fn();
    const coordinator = new CredentialCoordinator(
      state.store,
      KEY,
      transport(refresh),
      () => NOW,
    );

    await expect(
      coordinator.provider("account", 7).get(),
    ).rejects.toMatchObject({
      code: "ZENDESK_AUTH_REQUIRED",
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(state.compareAndSwap).not.toHaveBeenCalled();
  });

  it("marks expired refresh credentials unhealthy and pauses enabled scheduling", async () => {
    const state = await fixture(
      token({
        accessExpiresAt: NOW - 1,
        refreshExpiresAt: NOW - 1,
      }),
    );
    const refresh = vi.fn();
    const coordinator = new CredentialCoordinator(
      state.store,
      KEY,
      transport(refresh),
      () => NOW,
    );

    await expect(
      coordinator.provider("account", 7).get(),
    ).rejects.toMatchObject({
      code: "ZENDESK_AUTH_REQUIRED",
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(state.scheduler).toMatchObject({
      state: "paused",
      pauseReason: "permanent_failure",
      retryAttempt: 0,
    });
    expect(state.saveScheduler).toHaveBeenCalledTimes(1);
    const saved = await decryptConfiguration<{ zendesk: OAuthTokens }>(
      JSON.parse(state.configuration.credentialEnvelope),
      KEY,
    );
    expect(saved.zendesk.health).toBe("reconnect_required");
  });

  it("marks credentials unhealthy and pauses scheduling when refresh fails", async () => {
    const state = await fixture(token({ accessExpiresAt: NOW + 30_000 }));
    const refresh = vi.fn(async () => {
      throw new Error("provider detail must stay private");
    });
    const coordinator = new CredentialCoordinator(
      state.store,
      KEY,
      transport(refresh),
      () => NOW,
    );

    await expect(
      coordinator.provider("account", 7).onUnauthorized("Bearer access-old"),
    ).rejects.toMatchObject({
      code: "ZENDESK_AUTH_REQUIRED",
      message:
        "Zendesk renewal failed or is uncertain. Reconnect Zendesk, then resume scheduling.",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(state.scheduler).toMatchObject({
      state: "paused",
      pauseReason: "permanent_failure",
    });
    const saved = await decryptConfiguration<{ zendesk: OAuthTokens }>(
      JSON.parse(state.configuration.credentialEnvelope),
      KEY,
    );
    expect(saved.zendesk.health).toBe("reconnect_required");
  });

  it("fails closed when rotated credentials cannot win the CAS", async () => {
    const state = await fixture(token({ accessExpiresAt: NOW + 30_000 }));
    state.compareAndSwap.mockResolvedValue(false);
    const coordinator = new CredentialCoordinator(
      state.store,
      KEY,
      transport(async () => token({ accessToken: "access-new" })),
      () => NOW,
    );

    await expect(
      coordinator.provider("account", 7).onUnauthorized("Bearer access-old"),
    ).rejects.toMatchObject({ code: "ZENDESK_AUTH_REQUIRED" });
    expect(state.saveScheduler).not.toHaveBeenCalled();
  });

  it("does not reissue refresh after a credential CAS error", async () => {
    const state = await fixture(token({ accessExpiresAt: NOW + 30_000 }));
    state.compareAndSwap.mockRejectedValue(new Error("secret-canary"));
    const refreshed = token({ accessToken: "access-new" });
    const refresh = vi.fn(async () => refreshed);
    const coordinator = new CredentialCoordinator(
      state.store,
      KEY,
      transport(refresh),
      () => NOW,
    );
    const provider = coordinator.provider("account", 7);

    await expect(
      provider.onUnauthorized("Bearer access-old"),
    ).rejects.toMatchObject({
      code: "ZENDESK_AUTH_REQUIRED",
    });
    await expect(
      provider.onUnauthorized("Bearer access-old"),
    ).rejects.toMatchObject({
      code: "ZENDESK_AUTH_REQUIRED",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("returns a safe auth error when failed refresh health persistence also fails", async () => {
    const state = await fixture(token({ accessExpiresAt: NOW + 30_000 }));
    state.compareAndSwap.mockRejectedValue(new Error("secret-canary"));
    const refresh = vi.fn(async () => {
      throw new Error("provider-secret-canary");
    });
    const coordinator = new CredentialCoordinator(
      state.store,
      KEY,
      transport(refresh),
      () => NOW,
    );

    await expect(
      coordinator.provider("account", 7).onUnauthorized("Bearer access-old"),
    ).rejects.toMatchObject({
      code: "ZENDESK_AUTH_REQUIRED",
      message:
        "Zendesk renewal failed or is uncertain. Reconnect Zendesk, then resume scheduling.",
    });
    await expect(
      coordinator.provider("account", 7).get(),
    ).rejects.toMatchObject({ code: "ZENDESK_AUTH_REQUIRED" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refuses an encrypted credential envelope with the wrong key", async () => {
    const state = await fixture();
    const coordinator = new CredentialCoordinator(state.store, WRONG_KEY);

    await expect(
      coordinator.secrets(state.configuration.credentialEnvelope),
    ).rejects.toMatchObject({
      code: "CREDENTIAL_DECRYPTION_FAILED",
    });
  });
});
