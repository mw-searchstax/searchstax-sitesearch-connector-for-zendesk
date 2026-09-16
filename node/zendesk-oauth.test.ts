import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ContractError,
  OAUTH_SCOPE,
  OAuthAttempts,
  OAuthTransport,
  type OAuthFetcher,
  type OAuthTokens,
} from "./zendesk-oauth.ts";

const SETTINGS = {
  clientId: "zdg-fixture-client",
  redirectUri: "http://127.0.0.1:43127/oauth/callback",
};

function response(
  body: unknown,
  status = 200,
  init: ResponseInit = {},
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function tokenFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    token_type: "Bearer",
    access_token: "access-fixture",
    refresh_token: "refresh-fixture",
    expires_in: 1_800,
    refresh_token_expires_in: 2_592_000,
    scope: OAUTH_SCOPE,
    ...overrides,
  };
}

function fetchFixture(
  onRequest?: (input: RequestInfo | URL, init: RequestInit) => void,
): OAuthFetcher {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    onRequest?.(input, init ?? {});
    return response(tokenFixture());
  });
}

describe("OAuthTransport", () => {
  it("exchanges a code using S256-compatible JSON and validates the response TTLs", async () => {
    let captured: { input: RequestInfo | URL; init: RequestInit } | undefined;
    const transport = new OAuthTransport(
      SETTINGS,
      fetchFixture((input, init) => (captured = { input, init })),
      () => 1_000_000,
    );

    const tokens = await transport.exchange(
      "acme",
      "code-fixture",
      "verifier-fixture",
    );
    expect(String(captured?.input)).toBe(
      "https://acme.zendesk.com/oauth/tokens",
    );
    expect(captured?.init.method).toBe("POST");
    expect(captured?.init.redirect).toBe("error");
    const body = JSON.parse(String(captured?.init.body)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      grant_type: "authorization_code",
      code: "code-fixture",
      client_id: SETTINGS.clientId,
      redirect_uri: SETTINGS.redirectUri,
      code_verifier: "verifier-fixture",
      scope: OAUTH_SCOPE,
      expires_in: 1_800,
      refresh_token_expires_in: 2_592_000,
    });
    expect(body.client_secret).toBeUndefined();
    expect(tokens).toEqual({
      kind: "oauth",
      accountSubdomain: "acme",
      clientId: SETTINGS.clientId,
      accessToken: "access-fixture",
      refreshToken: "refresh-fixture",
      accessExpiresAt: 2_800_000,
      refreshExpiresAt: 2_593_000_000,
      generation: 1,
      scopes: ["brands:read", "hc:read"],
    });
  });

  it("rotates both tokens and joins concurrent refreshes", async () => {
    let calls = 0;
    const transport = new OAuthTransport(
      SETTINGS,
      vi.fn(async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return response(
          tokenFixture({
            access_token: "new-access",
            refresh_token: "new-refresh",
          }),
        );
      }),
      () => 1_000_000,
    );
    const current: OAuthTokens = {
      kind: "oauth",
      accountSubdomain: "acme",
      clientId: SETTINGS.clientId,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accessExpiresAt: 999_000,
      refreshExpiresAt: 9_000_000_000,
      generation: 4,
      scopes: ["brands:read", "hc:read"],
    };

    const [first, second] = await Promise.all([
      transport.refresh(current),
      transport.refresh(current),
    ]);
    expect(calls).toBe(1);
    expect(first).toEqual(second);
    expect(first.generation).toBe(5);
    expect(first.accessToken).toBe("new-access");
    expect(first.refreshToken).toBe("new-refresh");
    expect(current.refreshToken).toBe("old-refresh");
  });

  it("returns safe errors for invalid shape, redirects, and expired refresh", async () => {
    const invalid = new OAuthTransport(
      SETTINGS,
      fetchFixture(() => undefined),
      () => 1_000_000,
    );
    const malformed = vi.fn(async () =>
      response(tokenFixture({ scope: "read" })),
    );
    const malformedTransport = new OAuthTransport(
      SETTINGS,
      malformed,
      () => 1_000_000,
    );
    await expect(
      malformedTransport.exchange("acme", "code", "verifier"),
    ).rejects.toMatchObject({
      code: "OAUTH_RESPONSE_INVALID",
    });

    const redirect = new OAuthTransport(
      SETTINGS,
      vi.fn(async () => response("provider secret", 302)),
    );
    await expect(
      redirect.exchange("acme", "code", "verifier"),
    ).rejects.toMatchObject({
      code: "OAUTH_REDIRECT_REFUSED",
    });
    await expect(
      invalid.refresh({
        kind: "oauth",
        accountSubdomain: "acme",
        clientId: SETTINGS.clientId,
        accessToken: "a",
        refreshToken: "r",
        accessExpiresAt: 1,
        refreshExpiresAt: 999_999,
        generation: 1,
        scopes: ["brands:read", "hc:read"],
      }),
    ).rejects.toMatchObject({ code: "ZENDESK_AUTH_REQUIRED" });
    await expect(
      malformedTransport.exchange("acme.example", "secret-code", "verifier"),
    ).rejects.toMatchObject({ code: "OAUTH_INVALID_REQUEST" });
    expect(() => new OAuthTransport(SETTINGS, fetchFixture())).not.toThrow();
  });
});

describe("OAuthAttempts", () => {
  it("renews an expiring candidate once and keeps the rotated pair server-side", async () => {
    let now = 10_000;
    let release!: (value: Response) => void;
    const fetcher = vi.fn((_: RequestInfo | URL, init?: RequestInit) =>
      String(init?.body).includes("authorization_code")
        ? Promise.resolve(response(tokenFixture()))
        : new Promise<Response>((resolve) => (release = resolve)),
    );
    const transport = new OAuthTransport(SETTINGS, fetcher, () => now);
    const attempts = new OAuthAttempts(transport, {
      now: () => now,
      candidateTtlMs: 60 * 60 * 1_000,
    });
    const started = attempts.start(
      "acme",
      "setup",
      null,
      "browser-session-fixture",
    );
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const completed = await attempts.complete(
      state,
      "code",
      "browser-session-fixture",
      null,
    );
    now = 1_760_000;
    const provider = attempts.candidateAuthorization(
      completed.handle,
      "browser-session-fixture",
      null,
      "setup",
    );
    const first = provider.get();
    const second = provider.onUnauthorized("Bearer access-fixture");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    release(
      response(
        tokenFixture({
          access_token: "access-new",
          refresh_token: "refresh-new",
        }),
      ),
    );
    await expect(Promise.all([first, second])).resolves.toEqual([
      "Bearer access-new",
      "Bearer access-new",
    ]);
    expect(
      attempts.claimCandidate(completed.handle, "browser-session-fixture", null)
        .accessToken,
    ).toBe("access-new");
    expect(() =>
      attempts.candidate(completed.handle, "browser-session-fixture", null),
    ).toThrow();
  });

  it("invalidates a candidate consumed while renewal is in flight", async () => {
    let now = 10_000;
    let release!: (value: Response) => void;
    const fetcher = vi.fn((_: RequestInfo | URL, init?: RequestInit) =>
      String(init?.body).includes("authorization_code")
        ? Promise.resolve(response(tokenFixture()))
        : new Promise<Response>((resolve) => (release = resolve)),
    );
    const transport = new OAuthTransport(SETTINGS, fetcher, () => now);
    const attempts = new OAuthAttempts(transport, {
      now: () => now,
      candidateTtlMs: 60 * 60 * 1_000,
    });
    const started = attempts.start(
      "acme",
      "setup",
      null,
      "browser-session-fixture",
    );
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const completed = await attempts.complete(
      state,
      "code",
      "browser-session-fixture",
      null,
    );
    now = 1_760_000;
    const pending = attempts
      .candidateAuthorization(
        completed.handle,
        "browser-session-fixture",
        null,
        "setup",
      )
      .get();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(() =>
      attempts.claimCandidate(
        completed.handle,
        "browser-session-fixture",
        null,
      ),
    ).toThrow();
    attempts.consume(completed.handle);
    release(
      response(
        tokenFixture({
          access_token: "access-new",
          refresh_token: "refresh-new",
        }),
      ),
    );
    await expect(pending).rejects.toMatchObject({
      code: "OAUTH_ATTEMPT_INVALID",
    });
    expect(() =>
      attempts.candidate(completed.handle, "browser-session-fixture", null),
    ).toThrow();
  });

  it("builds an account-bound S256 authorization URL and keeps candidates server-side", async () => {
    let sentVerifier = "";
    const transport = new OAuthTransport(
      SETTINGS,
      fetchFixture((_input, init) => {
        sentVerifier = String(
          (JSON.parse(String(init.body)) as Record<string, unknown>)
            .code_verifier,
        );
      }),
      () => 10_000,
    );
    const attempts = new OAuthAttempts(transport, { now: () => 10_000 });
    const started = attempts.start(
      "acme",
      "setup",
      null,
      "browser-session-fixture",
    );
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.origin).toBe("https://acme.zendesk.com");
    expect(authorization.pathname).toBe("/oauth/authorizations/new");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      SETTINGS.redirectUri,
    );
    expect(authorization.searchParams.get("scope")).toBe(OAUTH_SCOPE);
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("state")).toBeTruthy();

    const completed = await attempts.complete(
      authorization.searchParams.get("state")!,
      "code-fixture",
      "browser-session-fixture",
      null,
    );
    expect(completed.handle).toBe(started.handle);
    expect(completed.intent).toBe("setup");
    expect(completed.tokens.accessToken).toBe("access-fixture");
    expect(
      createHash("sha256").update(sentVerifier, "ascii").digest("base64url"),
    ).toBe(authorization.searchParams.get("code_challenge"));

    const candidate = attempts.candidate(
      completed.handle,
      "browser-session-fixture",
      null,
      "setup",
    );
    expect(candidate).toEqual(completed.tokens);
    candidate.scopes.push("mutated-locally");
    expect(
      attempts.candidate(completed.handle, "browser-session-fixture", null)
        .scopes,
    ).toEqual(["brands:read", "hc:read"]);
    attempts.consume(completed.handle);
    expect(() =>
      attempts.candidate(completed.handle, "browser-session-fixture", null),
    ).toThrowError(
      new ContractError(
        "OAUTH_ATTEMPT_INVALID",
        "OAuth attempt was invalid or expired.",
      ),
    );
  });

  it("rejects mismatched cookie/revision and concurrent or replayed callbacks", async () => {
    const transport = new OAuthTransport(
      SETTINGS,
      fetchFixture(),
      () => 10_000,
    );
    const attempts = new OAuthAttempts(transport, { now: () => 10_000 });
    const started = attempts.start(
      "acme",
      "replace",
      7,
      "browser-session-fixture",
    );
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;

    await expect(
      attempts.complete(state, "code", "wrong-browser-session", 7),
    ).rejects.toMatchObject({
      code: "OAUTH_ATTEMPT_INVALID",
    });
    await expect(
      attempts.complete(state, "code", "browser-session-fixture", 6),
    ).rejects.toMatchObject({
      code: "OAUTH_ATTEMPT_INVALID",
    });
    await expect(
      attempts.complete(state, "code", "browser-session-fixture", 7),
    ).resolves.toMatchObject({ intent: "replace" });
    // The correctly bound callback consumes the state before exchange; it cannot be replayed.
    await expect(
      attempts.complete(state, "code", "browser-session-fixture", 7),
    ).rejects.toMatchObject({
      code: "OAUTH_ATTEMPT_INVALID",
    });

    const expiredNow = { value: 10_000 };
    const expiring = new OAuthAttempts(transport, {
      now: () => expiredNow.value,
      attemptTtlMs: 1_000,
    });
    const expiringStart = expiring.start(
      "acme",
      "setup",
      null,
      "browser-session-fixture",
    );
    expiredNow.value += 1_000;
    const expiringState = new URL(
      expiringStart.authorizationUrl,
    ).searchParams.get("state")!;
    await expect(
      expiring.complete(expiringState, "code", "browser-session-fixture", null),
    ).rejects.toMatchObject({ code: "OAUTH_ATTEMPT_INVALID" });
  });

  it("bounds attempts and expires candidates", async () => {
    let now = 10_000;
    const transport = new OAuthTransport(SETTINGS, fetchFixture(), () => now);
    const attempts = new OAuthAttempts(transport, {
      now: () => now,
      maxAttempts: 1,
      candidateTtlMs: 1_000,
    });
    attempts.start("acme", "setup", null, "browser-session-fixture");
    expect(() =>
      attempts.start("acme", "setup", null, "browser-session-fixture"),
    ).toThrowError(
      new ContractError(
        "OAUTH_ATTEMPT_LIMIT",
        "Too many OAuth attempts are in progress.",
      ),
    );
    now += 10 * 60 * 1_000;
    const started = attempts.start(
      "acme",
      "setup",
      null,
      "browser-session-fixture",
    );
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const completed = await attempts.complete(
      state,
      "code",
      "browser-session-fixture",
      null,
    );
    now += 1_000;
    expect(() =>
      attempts.candidate(completed.handle, "browser-session-fixture", null),
    ).toThrowError(
      new ContractError(
        "OAUTH_ATTEMPT_INVALID",
        "OAuth attempt was invalid or expired.",
      ),
    );
  });
});
