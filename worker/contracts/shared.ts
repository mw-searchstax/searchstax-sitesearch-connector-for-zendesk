export type Fetch = typeof fetch;

export interface RetryOptions {
  signal?: AbortSignal;
  fetch?: Fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
  deadlineAt?: number;
}

export class ContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

const RETRY_DELAYS = [2_000, 8_000] as const;
const MAX_RETRY_AFTER_MS = 300_000;

function retryDelay(response: Response, retryIndex: number): number {
  const value = response.headers.get("retry-after");
  if (value !== null && /^\d+$/u.test(value)) {
    return Math.min(Number(value) * 1_000, MAX_RETRY_AFTER_MS);
  }
  if (value !== null) {
    const retryAt = Date.parse(value);
    if (!Number.isNaN(retryAt) && retryAt > Date.now()) {
      return Math.min(retryAt - Date.now(), MAX_RETRY_AFTER_MS);
    }
  }
  return RETRY_DELAYS[retryIndex] ?? RETRY_DELAYS.at(-1)!;
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

function rejectionCategory(
  error: unknown,
  localDeadlineFired: boolean,
): "T" | "F" | "L" | "E" | "V" {
  if (isTimeoutError(error)) return "T";
  if (error instanceof TypeError) return "F";
  if (error instanceof Error || error instanceof DOMException)
    return localDeadlineFired ? "L" : "E";
  return "V";
}

export async function requestWithRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  options: RetryOptions,
  failurePrefix: string,
): Promise<Response> {
  const fetcher = options.fetch ?? fetch;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => performance.now());
  const remaining = () =>
    options.deadlineAt === undefined ? Infinity : options.deadlineAt - now();
  const attemptSequence: ("R" | "T" | "F" | "L" | "E" | "V")[] = [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    options.signal?.throwIfAborted();
    if (remaining() <= 0)
      throw new ContractError(
        "REQUEST_DEADLINE",
        `${failurePrefix} request deadline was reached.`,
      );
    let response: Response;
    const timeoutSignal = AbortSignal.timeout(
      Math.max(1, Math.floor(Math.min(timeoutMs, remaining()))),
    );
    try {
      response = await fetcher(input, {
        ...init,
        redirect: "manual",
        signal: options.signal
          ? AbortSignal.any([timeoutSignal, options.signal])
          : timeoutSignal,
      });
    } catch (error) {
      attemptSequence.push(rejectionCategory(error, timeoutSignal.aborted));
      if (attempt < 2) {
        await sleep(Math.min(RETRY_DELAYS[attempt]!, Math.max(0, remaining())));
        continue;
      }
      const signature = attemptSequence.join("");
      const rejectionOnly = !signature.includes("R");
      throw new ContractError(
        signature === "TTT"
          ? "REQUEST_TIMEOUT"
          : signature === "FFF"
            ? "FETCH_REJECTED"
            : rejectionOnly
              ? `REQUEST_REJECTED_${signature}`
              : `REQUEST_ATTEMPTS_${signature}`,
        signature === "TTT"
          ? `${failurePrefix} request timed out.`
          : signature === "FFF"
            ? `${failurePrefix} fetch was rejected.`
            : rejectionOnly
              ? `${failurePrefix} request rejection sequence was classified.`
              : `${failurePrefix} request attempt sequence was classified.`,
      );
    }

    if (response.status >= 300 && response.status <= 399) {
      await response.body?.cancel().catch(() => undefined);
      throw new ContractError(
        "REDIRECT_REFUSED",
        `${failurePrefix} redirect was refused.`,
      );
    }
    if (isRetryable(response.status) && attempt < 2) {
      attemptSequence.push("R");
      await response.body?.cancel().catch(() => undefined);
      await sleep(
        Math.min(retryDelay(response, attempt), Math.max(0, remaining())),
      );
      continue;
    }
    return response;
  }
  throw new ContractError("REQUEST_FAILED", `${failurePrefix} request failed.`);
}

export async function requireJsonResponse(
  response: Response,
  failurePrefix: string,
): Promise<unknown> {
  if (response.redirected) {
    throw new ContractError(
      "INVALID_RESPONSE",
      `${failurePrefix} redirect was refused.`,
    );
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new ContractError(
      response.status === 429 || response.status >= 500
        ? "TRANSIENT_HTTP_FAILURE"
        : "PERMANENT_HTTP_FAILURE",
      `${failurePrefix} request failed.`,
    );
  }
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/json")
  ) {
    throw new ContractError(
      "INVALID_RESPONSE",
      `${failurePrefix} response was invalid.`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ContractError(
      "INVALID_RESPONSE",
      `${failurePrefix} response was invalid.`,
    );
  }
}

export function record(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractError("INVALID_RESPONSE", message);
  }
  return value as Record<string, unknown>;
}

export function decimalString(value: unknown, name: string): string {
  const result = typeof value === "number" ? String(value) : value;
  if (typeof result !== "string" || !/^\d+$/u.test(result)) {
    throw new ContractError(
      "INVALID_RESPONSE",
      `${name} must be a decimal string.`,
    );
  }
  return result;
}
