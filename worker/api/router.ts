import type { ApplicationService, SetupInput } from "./types.ts";
import { ContractError } from "../contracts/shared.ts";

const MAX_BODY_BYTES = 32 * 1024;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  )
    throw new ApiError(415, "JSON_REQUIRED", "Use application/json.");
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES)
    throw new ApiError(413, "BODY_TOO_LARGE", "Request body was too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
    throw new ApiError(413, "BODY_TOO_LARGE", "Request body was too large.");
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body was invalid.");
  }
}

async function rawBody(request: Request): Promise<string> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  )
    throw new ApiError(415, "JSON_REQUIRED", "Use application/json.");
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES)
    throw new ApiError(413, "BODY_TOO_LARGE", "Request body was too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
    throw new ApiError(413, "BODY_TOO_LARGE", "Request body was too large.");
  return text;
}

function sameOrigin(request: Request) {
  if (["GET", "HEAD"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin)
    throw new ApiError(403, "ORIGIN_REJECTED", "Request origin was rejected.");
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new ApiError(400, "INVALID_INPUT", "Locale selection was invalid.");
  return value;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new ApiError(400, "INVALID_INPUT", `${name} was required.`);
  return value.trim();
}

function schedulerInput(input: Record<string, unknown>): boolean {
  if (Object.keys(input).length !== 1 || typeof input.enabled !== "boolean")
    throw new ApiError(400, "INVALID_INPUT", "Scheduler input was invalid.");
  return input.enabled;
}

function existingIndexApplyInput(input: Record<string, unknown>) {
  if (
    Object.keys(input).length !== 2 ||
    typeof input.legacyIngestionPaused !== "boolean"
  )
    throw new ApiError(400, "INVALID_INPUT", "Apply confirmation was invalid.");
  return {
    fingerprint: required(input.fingerprint, "Fingerprint"),
    legacyIngestionPaused: input.legacyIngestionPaused,
  };
}

function setupInput(input: Record<string, unknown>): SetupInput {
  return {
    accountSubdomain: required(input.accountSubdomain, "Zendesk subdomain"),
    email: input.oauthHandle ? "" : required(input.email, "Zendesk email"),
    apiToken: input.oauthHandle
      ? ""
      : required(input.apiToken, "Zendesk API token"),
    ...(typeof input.oauthHandle === "string"
      ? {
          oauthHandle: input.oauthHandle,
          _oauthSession: String(input._oauthSession ?? ""),
        }
      : {}),
    brandId: required(input.brandId, "Brand"),
    locales: strings(input.locales),
    connectorKey: required(input.connectorKey, "Connector key"),
    updateEndpoint: required(input.updateEndpoint, "Update endpoint"),
    selectEndpoint: required(input.selectEndpoint, "Select endpoint"),
    token: required(input.token, "SearchStax token"),
    destinationName: required(input.destinationName, "Destination name"),
    ...(typeof input.previewUrl === "string" && input.previewUrl.trim()
      ? { previewUrl: input.previewUrl.trim() }
      : {}),
  };
}

export function createApiHandler(service: ApplicationService) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === "GET" && path === "/api/webhooks/zendesk/status")
        return json(
          service.webhookStatus?.() ?? {
            enabled: false,
            endpoint: "/api/webhooks/zendesk",
            requiresHttps: true,
            signingSecretConfigured: false,
          },
        );
      if (request.method === "POST" && path === "/api/webhooks/zendesk") {
        if (!service.receiveZendeskWebhook)
          throw new ApiError(
            501,
            "WEBHOOK_UNAVAILABLE",
            "Realtime webhook delivery is unavailable.",
          );
        const raw = await rawBody(request);
        const result = await service.receiveZendeskWebhook(
          raw,
          request.headers.get("x-zendesk-webhook-signature"),
          request.headers.get("x-zendesk-webhook-signature-timestamp"),
          url.protocol === "https:",
        );
        return json(result, result.accepted ? 202 : 200);
      }
      sameOrigin(request);
      const session =
        request.headers
          .get("cookie")
          ?.split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith("zendesk_oauth="))
          ?.slice(14) ?? "";
      const inputBody = async (): Promise<Record<string, unknown>> => ({
        ...(await body(request)),
        _oauthSession: session,
      });
      if (request.method === "POST" && path === "/api/oauth/zendesk/cancel") {
        await body(request);
        await service.oauthCancel?.(session);
        return json({ canceled: true });
      }
      if (request.method === "POST" && path === "/api/oauth/zendesk/start") {
        if (!service.oauthStart)
          throw new ApiError(
            409,
            "OAUTH_UNAVAILABLE",
            "OAuth is not configured for this installation.",
          );
        const browserSession = /^[a-f0-9]{64}$/.test(session)
          ? session
          : Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
              b.toString(16).padStart(2, "0"),
            ).join("");
        const result = await service.oauthStart(
          await body(request),
          browserSession,
        );
        const response = json(result);
        response.headers.set(
          "set-cookie",
          `zendesk_oauth=${browserSession}; HttpOnly; SameSite=Lax; Path=/api/; Max-Age=900${url.protocol === "https:" ? "; Secure" : ""}`,
        );
        return response;
      }
      if (request.method === "GET" && path === "/api/oauth/zendesk/callback") {
        // Always remove the provider query, including failures, without echoing it.
        let outcome = "failed";
        try {
          if (!service.oauthCallback || url.searchParams.has("error")) {
            await service.oauthCancel?.(session);
            throw new Error();
          }
          await service.oauthCallback(
            url.searchParams.get("state") ?? "",
            url.searchParams.get("code") ?? "",
            session,
          );
          outcome = "connected";
        } catch {
          /* Only a fixed safe outcome reaches the browser. */
        }
        return new Response(null, {
          status: 303,
          headers: {
            location: `/?zendesk_oauth=${outcome}`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      }
      if (request.method === "GET" && path === "/api/oauth/zendesk/candidate")
        return json((await service.oauthCandidate?.(session)) ?? null);

      if (request.method === "GET" && path === "/api/setup")
        return json(await service.setup());
      if (request.method === "GET" && path === "/api/setup/searchstax/status")
        return json(await service.readinessStatus());
      if (request.method === "POST" && path === "/api/setup/zendesk/validate")
        return json(await service.validateZendesk(await inputBody()));
      if (
        request.method === "POST" &&
        path === "/api/setup/searchstax/validate"
      ) {
        await service.checkSearchStaxConnection(await body(request));
        return json({ connectionValidated: true });
      }
      if (request.method === "POST" && path === "/api/setup/retry")
        return json(await service.retrySetup(await body(request)), 202);
      if (request.method === "POST" && path === "/api/setup/complete") {
        const input = await inputBody();
        return json(await service.completeSetup(setupInput(input)), 201);
      }
      if (request.method === "POST" && path === "/api/recovery/plan")
        return json(await service.planRecovery(setupInput(await inputBody())));
      if (request.method === "POST" && path === "/api/recovery/apply") {
        const input = await inputBody();
        return json(
          await service.applyRecovery(
            setupInput(input),
            required(input.fingerprint, "Fingerprint"),
          ),
          201,
        );
      }
      if (request.method === "PUT" && path === "/api/credentials/zendesk")
        return json(await service.replaceZendesk(await inputBody()));
      if (request.method === "PUT" && path === "/api/credentials/searchstax")
        return json(await service.replaceSearchStax(await body(request)));
      if (request.method === "GET" && path === "/api/dashboard")
        return json(await service.dashboard());
      if (request.method === "PUT" && path === "/api/scheduler")
        return json(
          await service.setScheduler(schedulerInput(await body(request))),
        );
      if (request.method === "GET" && path === "/api/runs")
        return json(
          await service.runs(url.searchParams.get("cursor") ?? undefined),
        );
      if (request.method === "POST" && path === "/api/runs") {
        await body(request);
        return json(await service.startRun(), 202);
      }
      if (request.method === "POST" && path === "/api/existing-index/dry-run") {
        await body(request);
        return json(await service.existingIndexDryRun());
      }
      if (request.method === "POST" && path === "/api/existing-index/apply") {
        const input = existingIndexApplyInput(await body(request));
        if (!input.legacyIngestionPaused)
          throw new ApiError(
            409,
            "LEGACY_INGESTION_NOT_PAUSED",
            "Confirm that legacy crawler or ingestion processes are paused or disabled before apply.",
          );
        return json(
          await service.existingIndexApply(
            input.fingerprint,
            input.legacyIngestionPaused,
          ),
        );
      }
      const cancel = path.match(/^\/api\/runs\/([^/]+)\/cancel$/u);
      if (request.method === "POST" && cancel) {
        await body(request);
        await service.cancelRun(decodeURIComponent(cancel[1]));
        return json({ canceled: true }, 202);
      }
      if (request.method === "POST" && path === "/api/locales/plan") {
        const input = await body(request);
        return json(await service.planLocales(strings(input.locales)));
      }
      if (request.method === "POST" && path === "/api/locales/apply") {
        const input = await body(request);
        return json(
          await service.applyLocales(
            required(input.planId, "Locale plan"),
            required(input.fingerprint, "Fingerprint"),
          ),
        );
      }
      const deletion = path.match(/^\/api\/deletion-plans\/([^/]+)$/u);
      if (request.method === "GET" && deletion)
        return json(
          await service.deletionPlan(decodeURIComponent(deletion[1])),
        );
      const confirm = path.match(/^\/api\/deletion-plans\/([^/]+)\/confirm$/u);
      if (request.method === "POST" && confirm) {
        const input = await body(request);
        await service.confirmDeletion(
          decodeURIComponent(confirm[1]),
          required(input.fingerprint, "Fingerprint"),
        );
        return json({ confirmed: true }, 202);
      }
      return json(
        { error: { code: "NOT_FOUND", message: "Route not found." } },
        404,
      );
    } catch (error) {
      const safe =
        error instanceof ApiError
          ? error
          : error instanceof ContractError
            ? new ApiError(400, error.code, error.message)
            : new ApiError(
                400,
                "REQUEST_FAILED",
                "The request could not be completed.",
              );
      return json(
        { error: { code: safe.code, message: safe.message } },
        safe.status,
      );
    }
  };
}
