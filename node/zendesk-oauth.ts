import { createHash, randomBytes } from "node:crypto";

import { ContractError } from "../worker/contracts/shared.ts";

export { ContractError } from "../worker/contracts/shared.ts";

export interface OAuthTokens {
  kind: "oauth";
  accountSubdomain: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  generation: number;
  scopes: string[];
  health?: "reconnect_required";
}

export interface OAuthSettings {
  clientId: string;
  redirectUri: string;
}

export type OAuthIntent = "setup" | "replace";

export interface OAuthCompletion {
  handle: string;
  tokens: OAuthTokens;
  intent: OAuthIntent;
}

export type OAuthFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OAuthErrorCode =
  | "OAUTH_INVALID_REQUEST"
  | "OAUTH_ATTEMPT_INVALID"
  | "OAUTH_ATTEMPT_LIMIT"
  | "OAUTH_EXCHANGE_FAILED"
  | "ZENDESK_AUTH_REQUIRED"
  | "OAUTH_RESPONSE_INVALID"
  | "OAUTH_TIMEOUT"
  | "OAUTH_REDIRECT_REFUSED"
  | "OAUTH_DENIED";

const ERROR_MESSAGES: Record<OAuthErrorCode, string> = {
  OAUTH_INVALID_REQUEST: "OAuth request was invalid.",
  OAUTH_ATTEMPT_INVALID: "OAuth attempt was invalid or expired.",
  OAUTH_ATTEMPT_LIMIT: "Too many OAuth attempts are in progress.",
  OAUTH_EXCHANGE_FAILED: "OAuth exchange failed.",
  ZENDESK_AUTH_REQUIRED: "Reconnect Zendesk before continuing.",
  OAUTH_RESPONSE_INVALID: "OAuth provider response was invalid.",
  OAUTH_TIMEOUT: "OAuth provider request timed out.",
  OAUTH_REDIRECT_REFUSED: "OAuth provider redirect was refused.",
  OAUTH_DENIED: "OAuth authorization was denied.",
};

function oauthError(code: OAuthErrorCode): ContractError {
  return new ContractError(code, ERROR_MESSAGES[code]);
}

export const OAUTH_SCOPES = ["brands:read", "hc:read"] as const;
export const OAUTH_SCOPE = OAUTH_SCOPES.join(" ");
export const OAUTH_ACCESS_TTL_SECONDS = 1_800;
export const OAUTH_REFRESH_TTL_SECONDS = 2_592_000;
export const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1_000;
export const OAUTH_CANDIDATE_TTL_MS = 10 * 60 * 1_000;
export const OAUTH_MAX_ATTEMPTS = 16;
export const OAUTH_MAX_CANDIDATES = 1_024;
export const OAUTH_TIMEOUT_MS = 15_000;
export const OAUTH_RESPONSE_MAX_BYTES = 64 * 1_024;
export const OAUTH_CALLBACK_COOKIE = "zendesk_oauth_attempt";

const ACCOUNT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CLIENT_PATTERN = /^[\x21-\x7e]{1,256}$/;

function invalidRequest(): never {
  throw oauthError("OAUTH_INVALID_REQUEST");
}

function validateAccount(account: string): string {
  if (typeof account !== "string" || !ACCOUNT_PATTERN.test(account))
    invalidRequest();
  return account;
}

function validateClientId(clientId: string): string {
  if (typeof clientId !== "string" || !CLIENT_PATTERN.test(clientId))
    invalidRequest();
  return clientId;
}

function validateRedirectUri(redirectUri: string): string {
  if (typeof redirectUri !== "string" || redirectUri.length > 512)
    invalidRequest();
  let uri: URL;
  try {
    uri = new URL(redirectUri);
  } catch {
    invalidRequest();
  }
  if (
    uri.protocol !== "http:" ||
    uri.hostname !== "127.0.0.1" ||
    uri.username ||
    uri.password ||
    uri.search ||
    uri.hash ||
    !uri.port ||
    !uri.pathname.startsWith("/")
  )
    invalidRequest();
  return uri.href;
}

function validateRevision(revision: number | null): number | null {
  if (revision !== null && (!Number.isSafeInteger(revision) || revision < 0))
    invalidRequest();
  return revision;
}

function validateBrowserSession(browserSession: string): string {
  if (
    typeof browserSession !== "string" ||
    browserSession.length < 16 ||
    browserSession.length > 512
  )
    invalidRequest();
  return browserSession;
}

function randomHandle(): string {
  return randomBytes(24).toString("base64url");
}

function pkceVerifier(): string {
  // RFC 7636 permits 43–128 unreserved characters. base64url(32 bytes) is 43.
  return randomBytes(32).toString("base64url");
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function validTokenString(value: unknown, maximum = 16_384): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

function scopeList(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const values = value.split(/\s+/).filter(Boolean);
  if (
    values.length !== OAUTH_SCOPES.length ||
    new Set(values).size !== values.length ||
    values.some(
      (scope) => !OAUTH_SCOPES.includes(scope as (typeof OAUTH_SCOPES)[number]),
    )
  )
    return undefined;
  return [...OAUTH_SCOPES];
}

function validTtl(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

async function boundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) throw oauthError("OAUTH_RESPONSE_INVALID");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
}

export class OAuthTransport {
  readonly settings: OAuthSettings;
  private readonly fetcher: OAuthFetcher;
  private readonly now: () => number;
  private readonly refreshes = new Map<string, Promise<OAuthTokens>>();

  constructor(
    settings: OAuthSettings,
    fetcher: OAuthFetcher = fetch,
    now: () => number = Date.now,
  ) {
    this.settings = {
      clientId: validateClientId(settings.clientId),
      redirectUri: validateRedirectUri(settings.redirectUri),
    };
    this.fetcher = fetcher;
    this.now = now;
  }

  async exchange(
    account: string,
    code: string,
    verifier: string,
  ): Promise<OAuthTokens> {
    validateAccount(account);
    if (!validTokenString(code, 4_096) || !validTokenString(verifier, 128))
      invalidRequest();
    const acquiredAt = this.now();
    return await this.post(
      account,
      {
        grant_type: "authorization_code",
        code,
        client_id: this.settings.clientId,
        redirect_uri: this.settings.redirectUri,
        code_verifier: verifier,
        scope: OAUTH_SCOPE,
        expires_in: OAUTH_ACCESS_TTL_SECONDS,
        refresh_token_expires_in: OAUTH_REFRESH_TTL_SECONDS,
      },
      1,
      acquiredAt,
    );
  }

  async refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
    validateTokens(tokens);
    if (tokens.clientId !== this.settings.clientId) {
      throw oauthError("ZENDESK_AUTH_REQUIRED");
    }
    if (tokens.refreshExpiresAt <= this.now())
      throw oauthError("ZENDESK_AUTH_REQUIRED");
    const key = `${tokens.accountSubdomain}\u0000${tokens.generation}\u0000${tokens.refreshToken}`;
    const existing = this.refreshes.get(key);
    if (existing) return await existing;
    const acquiredAt = this.now();
    const request = this.post(
      tokens.accountSubdomain,
      {
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: this.settings.clientId,
        scope: OAUTH_SCOPE,
        expires_in: OAUTH_ACCESS_TTL_SECONDS,
        refresh_token_expires_in: OAUTH_REFRESH_TTL_SECONDS,
      },
      tokens.generation + 1,
      acquiredAt,
    );
    this.refreshes.set(key, request);
    try {
      return await request;
    } finally {
      if (this.refreshes.get(key) === request) this.refreshes.delete(key);
    }
  }

  private async post(
    account: string,
    body: Record<string, string | number>,
    generation: number,
    acquiredAt: number,
  ): Promise<OAuthTokens> {
    const endpoint = `https://${account}.zendesk.com/oauth/tokens`;
    let response: Response;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      timer = setTimeout(() => controller.abort(), OAUTH_TIMEOUT_MS);
      response = await this.fetcher(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      if (timer !== undefined) clearTimeout(timer);
      if (controller.signal.aborted) throw oauthError("OAUTH_TIMEOUT");
      throw oauthError("ZENDESK_AUTH_REQUIRED");
    }
    try {
      if (response.status >= 300 && response.status < 400)
        throw oauthError("OAUTH_REDIRECT_REFUSED");
      if (response.url && response.url !== endpoint)
        throw oauthError("OAUTH_REDIRECT_REFUSED");
      const contentLength = response.headers.get("content-length");
      if (
        contentLength !== null &&
        (!/^\d+$/u.test(contentLength) ||
          Number(contentLength) > OAUTH_RESPONSE_MAX_BYTES)
      )
        throw oauthError("OAUTH_RESPONSE_INVALID");
      let raw: string;
      try {
        raw = await boundedResponseText(response, OAUTH_RESPONSE_MAX_BYTES);
      } catch (error) {
        if (controller.signal.aborted) throw oauthError("OAUTH_TIMEOUT");
        if (error instanceof ContractError) throw error;
        throw oauthError("ZENDESK_AUTH_REQUIRED");
      }
      if (Buffer.byteLength(raw, "utf8") > OAUTH_RESPONSE_MAX_BYTES)
        throw oauthError("OAUTH_RESPONSE_INVALID");
      if (!response.ok) {
        // Read and discard the body: provider descriptions may contain secrets.
        throw oauthError(
          response.status === 400 || response.status === 401
            ? "ZENDESK_AUTH_REQUIRED"
            : "OAUTH_EXCHANGE_FAILED",
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw oauthError("OAUTH_RESPONSE_INVALID");
      }
      return tokenResponse(
        payload,
        account,
        this.settings.clientId,
        generation,
        acquiredAt,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function tokenResponse(
  payload: unknown,
  account: string,
  clientId: string,
  generation: number,
  acquiredAt: number,
): OAuthTokens {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw oauthError("OAUTH_RESPONSE_INVALID");
  const candidate = payload as Record<string, unknown>;
  const scopes = scopeList(candidate.scope);
  if (
    !validTokenString(candidate.access_token) ||
    !validTokenString(candidate.refresh_token) ||
    scopes === undefined ||
    !validTtl(candidate.expires_in, 300, 172_800) ||
    !validTtl(candidate.refresh_token_expires_in, 604_800, 7_776_000) ||
    (candidate.token_type !== undefined &&
      (typeof candidate.token_type !== "string" ||
        candidate.token_type.toLowerCase() !== "bearer"))
  )
    throw oauthError("OAUTH_RESPONSE_INVALID");
  const accessExpiresAt = acquiredAt + candidate.expires_in * 1_000;
  const refreshExpiresAt =
    acquiredAt + candidate.refresh_token_expires_in * 1_000;
  if (
    !Number.isSafeInteger(accessExpiresAt) ||
    !Number.isSafeInteger(refreshExpiresAt) ||
    refreshExpiresAt <= accessExpiresAt
  )
    throw oauthError("OAUTH_RESPONSE_INVALID");
  return {
    kind: "oauth",
    accountSubdomain: account,
    clientId,
    accessToken: candidate.access_token,
    refreshToken: candidate.refresh_token,
    accessExpiresAt,
    refreshExpiresAt,
    generation,
    scopes,
  };
}

function validateTokens(tokens: OAuthTokens): void {
  if (
    !tokens ||
    tokens.kind !== "oauth" ||
    !ACCOUNT_PATTERN.test(tokens.accountSubdomain) ||
    !validTokenString(tokens.clientId, 256) ||
    !validTokenString(tokens.accessToken) ||
    !validTokenString(tokens.refreshToken) ||
    !Number.isSafeInteger(tokens.accessExpiresAt) ||
    !Number.isSafeInteger(tokens.refreshExpiresAt) ||
    !Number.isSafeInteger(tokens.generation) ||
    tokens.generation < 1 ||
    !Array.isArray(tokens.scopes) ||
    scopeList(tokens.scopes.join(" ")) === undefined ||
    (tokens.health !== undefined && tokens.health !== "reconnect_required")
  )
    throw oauthError("OAUTH_INVALID_REQUEST");
}

interface Attempt {
  account: string;
  intent: OAuthIntent;
  revision: number | null;
  browserSession: string;
  state: string;
  verifier: string;
  handle: string;
  expiresAt: number;
}

interface Candidate {
  tokens: OAuthTokens;
  intent: OAuthIntent;
  browserSession: string;
  revision: number | null;
  expiresAt: number;
}

export interface OAuthAttemptsOptions {
  now?: () => number;
  attemptTtlMs?: number;
  candidateTtlMs?: number;
  maxAttempts?: number;
  maxCandidates?: number;
}

/** In-memory, bounded state for browser OAuth attempts and uncommitted pairs. */
export class OAuthAttempts {
  private readonly attempts = new Map<string, Attempt>();
  private readonly candidates = new Map<string, Candidate>();
  private readonly now: () => number;
  private readonly attemptTtlMs: number;
  private readonly candidateTtlMs: number;
  private readonly maxAttempts: number;
  private readonly maxCandidates: number;
  private readonly candidateRefreshes = new Map<string, Promise<OAuthTokens>>();

  constructor(
    private readonly transport: OAuthTransport,
    options: OAuthAttemptsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.attemptTtlMs = boundedDuration(
      options.attemptTtlMs,
      OAUTH_ATTEMPT_TTL_MS,
    );
    this.candidateTtlMs = boundedDuration(
      options.candidateTtlMs,
      OAUTH_CANDIDATE_TTL_MS,
    );
    this.maxAttempts = boundedCount(options.maxAttempts, OAUTH_MAX_ATTEMPTS);
    this.maxCandidates = boundedCount(
      options.maxCandidates,
      OAUTH_MAX_CANDIDATES,
      OAUTH_MAX_CANDIDATES,
    );
  }

  start(
    account: string,
    intent: OAuthIntent,
    revision: number | null,
    browserSession: string,
  ): { authorizationUrl: string; handle: string } {
    validateAccount(account);
    if (intent !== "setup" && intent !== "replace") invalidRequest();
    validateRevision(revision);
    validateBrowserSession(browserSession);
    this.prune();
    if (this.attempts.size >= this.maxAttempts)
      throw oauthError("OAUTH_ATTEMPT_LIMIT");
    const state = randomHandle();
    const verifier = pkceVerifier();
    const handle = randomHandle();
    this.attempts.set(state, {
      account,
      intent,
      revision,
      browserSession,
      state,
      verifier,
      handle,
      expiresAt: this.now() + this.attemptTtlMs,
    });
    const authorization = new URL(
      `https://${account}.zendesk.com/oauth/authorizations/new`,
    );
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set(
      "client_id",
      this.transport.settings.clientId,
    );
    authorization.searchParams.set(
      "redirect_uri",
      this.transport.settings.redirectUri,
    );
    authorization.searchParams.set("scope", OAUTH_SCOPE);
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("code_challenge", s256(verifier));
    authorization.searchParams.set("code_challenge_method", "S256");
    return { authorizationUrl: authorization.href, handle };
  }

  async complete(
    state: string,
    code: string,
    browserSession: string,
    revision: number | null,
  ): Promise<OAuthCompletion> {
    if (!validTokenString(state, 128) || !validTokenString(code, 4_096))
      throw oauthError("OAUTH_ATTEMPT_INVALID");
    validateBrowserSession(browserSession);
    validateRevision(revision);
    const attempt = this.attempts.get(state);
    if (!attempt) throw oauthError("OAUTH_ATTEMPT_INVALID");
    if (attempt.expiresAt <= this.now()) {
      this.attempts.delete(state);
      throw oauthError("OAUTH_ATTEMPT_INVALID");
    }
    if (
      attempt.browserSession !== browserSession ||
      attempt.revision !== revision
    )
      throw oauthError("OAUTH_ATTEMPT_INVALID");
    // Delete after binding checks but before awaiting exchange. A wrong-cookie
    // callback cannot consume the legitimate attempt, while concurrent valid
    // callbacks still cannot reuse the one-time state.
    this.attempts.delete(state);
    let tokens: OAuthTokens;
    try {
      tokens = await this.transport.exchange(
        attempt.account,
        code,
        attempt.verifier,
      );
    } catch (error) {
      if (error instanceof ContractError) throw error;
      throw oauthError("ZENDESK_AUTH_REQUIRED");
    }
    this.prune();
    if (this.candidates.size >= this.maxCandidates)
      throw oauthError("OAUTH_ATTEMPT_LIMIT");
    this.candidates.set(attempt.handle, {
      tokens,
      intent: attempt.intent,
      browserSession: attempt.browserSession,
      revision: attempt.revision,
      expiresAt: this.now() + this.candidateTtlMs,
    });
    return {
      handle: attempt.handle,
      tokens: cloneTokens(tokens),
      intent: attempt.intent,
    };
  }

  candidate(
    handle: string,
    browserSession: string,
    revision: number | null,
    intent?: OAuthIntent,
  ): OAuthTokens {
    if (!validTokenString(handle, 128))
      throw oauthError("OAUTH_ATTEMPT_INVALID");
    validateBrowserSession(browserSession);
    validateRevision(revision);
    const candidate = this.candidates.get(handle);
    if (
      !candidate ||
      candidate.expiresAt <= this.now() ||
      candidate.browserSession !== browserSession ||
      candidate.revision !== revision ||
      (intent !== undefined && candidate.intent !== intent)
    ) {
      if (candidate && candidate.expiresAt <= this.now())
        this.candidates.delete(handle);
      throw oauthError("OAUTH_ATTEMPT_INVALID");
    }
    return cloneTokens(candidate.tokens);
  }

  candidateAuthorization(
    handle: string,
    browserSession: string,
    revision: number | null,
    intent?: OAuthIntent,
  ) {
    const current = () =>
      this.candidate(handle, browserSession, revision, intent);
    const bearer = (tokens: OAuthTokens) => `Bearer ${tokens.accessToken}`;
    const renew = async (previous?: string): Promise<string> => {
      const tokens = current();
      const currentBearer = bearer(tokens);
      const existing = this.candidateRefreshes.get(handle);
      if (existing) {
        try {
          const refreshed = await existing;
          if (!this.candidates.has(handle))
            throw oauthError("OAUTH_ATTEMPT_INVALID");
          return bearer(refreshed);
        } catch {
          throw oauthError("ZENDESK_AUTH_REQUIRED");
        }
      }
      if (
        previous &&
        previous !== currentBearer &&
        tokens.accessExpiresAt > this.now() + 60_000
      )
        return currentBearer;
      if (tokens.accessExpiresAt > this.now() + 60_000 && !previous)
        return currentBearer;
      const request = (async () => {
        try {
          const refreshed = await this.transport.refresh(tokens);
          const candidate = this.candidates.get(handle);
          if (!candidate || candidate.expiresAt <= this.now())
            throw oauthError("OAUTH_ATTEMPT_INVALID");
          candidate.tokens = refreshed;
          return refreshed;
        } catch (error) {
          this.candidates.delete(handle);
          if (
            error instanceof ContractError &&
            error.code === "OAUTH_ATTEMPT_INVALID"
          )
            throw error;
          throw oauthError("ZENDESK_AUTH_REQUIRED");
        }
      })();
      this.candidateRefreshes.set(handle, request);
      try {
        return bearer(await request);
      } catch (error) {
        if (
          error instanceof ContractError &&
          error.code === "OAUTH_ATTEMPT_INVALID"
        )
          throw error;
        throw oauthError("ZENDESK_AUTH_REQUIRED");
      } finally {
        if (this.candidateRefreshes.get(handle) === request)
          this.candidateRefreshes.delete(handle);
      }
    };
    return {
      get: () => renew(),
      onUnauthorized: (previous: string) => renew(previous),
    };
  }

  /** Atomically take a candidate for persistence after all validation is done. */
  claimCandidate(
    handle: string,
    browserSession: string,
    revision: number | null,
    intent?: OAuthIntent,
  ): OAuthTokens {
    if (this.candidateRefreshes.has(handle))
      throw oauthError("OAUTH_ATTEMPT_INVALID");
    const tokens = this.candidate(handle, browserSession, revision, intent);
    this.candidates.delete(handle);
    return tokens;
  }

  discardSession(browserSession: string): void {
    for (const [state, attempt] of this.attempts)
      if (attempt.browserSession === browserSession)
        this.attempts.delete(state);
    for (const [handle, candidate] of this.candidates)
      if (candidate.browserSession === browserSession)
        this.candidates.delete(handle);
  }

  consume(handle: string): void {
    if (!validTokenString(handle, 128))
      throw oauthError("OAUTH_ATTEMPT_INVALID");
    this.candidates.delete(handle);
  }

  private prune(): void {
    const now = this.now();
    for (const [state, attempt] of this.attempts)
      if (attempt.expiresAt <= now) this.attempts.delete(state);
    for (const [handle, candidate] of this.candidates)
      if (candidate.expiresAt <= now) this.candidates.delete(handle);
  }
}

function cloneTokens(tokens: OAuthTokens): OAuthTokens {
  return { ...tokens, scopes: [...tokens.scopes] };
}

function boundedDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60 * 60 * 1_000)
    invalidRequest();
  return value;
}

function boundedCount(
  value: number | undefined,
  fallback: number,
  maximum = OAUTH_MAX_ATTEMPTS,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    invalidRequest();
  return value;
}
