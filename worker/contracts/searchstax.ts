import {
  SEARCHSTAX_BODY_LIMIT_BYTES,
  type Json,
  type PreparedRecord,
} from "./record.ts";
import {
  ContractError,
  record,
  requestWithRetry,
  requireJsonResponse,
  type RetryOptions,
} from "./shared.ts";

export interface SearchStaxSettings {
  updateEndpoint: string;
  selectEndpoint: string;
  token: string;
}

export interface PendingProbeStore {
  get(): Promise<string | null>;
  set(id: string): Promise<void>;
  clear(id: string): Promise<void>;
}

export interface SearchStaxClient extends RetryOptions {
  settings: SearchStaxSettings;
  visibilityMaxAttempts?: number;
  visibilityPollMs?: number;
  cleanupDeadlineAt?: number;
}

export type ReadinessPhase =
  | "recovering_cleanup"
  | "writing"
  | "waiting_for_visibility"
  | "deleting"
  | "confirming_cleanup";

export interface SearchStaxBatch {
  records: readonly PreparedRecord[];
  body: string;
  byteSize: number;
}

export interface SearchStaxCandidate {
  id: string;
  document: Record<string, Json>;
}

export const SEARCHSTAX_CANDIDATE_URL_FIELDS = [
  "url",
  "url_s",
  "ss_url",
] as const;
export type SearchStaxCandidateUrlField =
  (typeof SEARCHSTAX_CANDIDATE_URL_FIELDS)[number];
export type SearchStaxCandidateFieldAvailability = Readonly<
  Record<
    SearchStaxCandidateUrlField,
    | { state: "queryable" }
    | { state: "unavailable"; reasonCode: "UNDEFINED_FIELD" }
  >
>;
export interface SearchStaxCandidateDiscovery {
  candidates: readonly SearchStaxCandidate[];
  fieldAvailability: SearchStaxCandidateFieldAvailability;
}

function endpoint(value: string, kind: "update" | "select"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ContractError(
      "INVALID_CONFIGURATION",
      `SearchStax ${kind} endpoint was invalid.`,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (kind === "update" && !/\/update(?:\/json\/docs)?$/u.test(url.pathname)) ||
    (kind === "select" && !/\/(?:em)?select$/u.test(url.pathname))
  ) {
    throw new ContractError(
      "INVALID_CONFIGURATION",
      `SearchStax ${kind} endpoint was invalid.`,
    );
  }
  if (kind === "select")
    url.pathname = url.pathname.replace(/\/emselect$/u, "/select");
  return url;
}

export function normalizeSearchStaxSettings(
  value: SearchStaxSettings,
): SearchStaxSettings {
  const normalized = settings({ settings: value });
  return {
    updateEndpoint: normalized.update.href,
    selectEndpoint: normalized.select.href,
    token: normalized.token,
  };
}

function settings(client: SearchStaxClient) {
  const token = client.settings.token.trim();
  if (!token)
    throw new ContractError(
      "INVALID_CONFIGURATION",
      "SearchStax token was missing.",
    );
  const update = endpoint(client.settings.updateEndpoint, "update");
  const select = endpoint(client.settings.selectEndpoint, "select");
  if (update.origin !== select.origin)
    throw new ContractError(
      "INVALID_CONFIGURATION",
      "SearchStax endpoints must use the same origin.",
    );
  return {
    update,
    select,
    token,
  };
}

function acknowledged(value: unknown): Record<string, unknown> {
  const body = record(value, "SearchStax response was invalid.");
  const header = record(
    body.responseHeader,
    "SearchStax acknowledgement was invalid.",
  );
  if (header.status !== 0)
    throw new ContractError(
      "INVALID_RESPONSE",
      "SearchStax did not acknowledge the request.",
    );
  return body;
}

async function jsonRequest(
  client: SearchStaxClient,
  url: URL,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await requestWithRetry(url, init, client, "SearchStax");
  return acknowledged(await requireJsonResponse(response, "SearchStax"));
}

export function isSearchStaxUndefinedFieldError(
  value: unknown,
  field: SearchStaxCandidateUrlField,
): boolean {
  try {
    const body = record(value, "SearchStax error response was invalid.");
    const header = record(
      body.responseHeader,
      "SearchStax error response was invalid.",
    );
    const error = record(body.error, "SearchStax error response was invalid.");
    return (
      header.status === 400 &&
      error.code === 400 &&
      (error.msg === `undefined field: ${field}` ||
        error.msg === `undefined field ${field}`)
    );
  } catch {
    return false;
  }
}

async function candidateJsonRequest(
  client: SearchStaxClient,
  url: URL,
  field: SearchStaxCandidateUrlField,
): Promise<Record<string, unknown> | undefined> {
  const response = await requestWithRetry(
    url,
    { headers: { authorization: `Token ${settings(client).token}` } },
    client,
    "SearchStax",
  );
  if (response.status !== 400)
    return acknowledged(await requireJsonResponse(response, "SearchStax"));
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/json")
  ) {
    throw new ContractError(
      "PERMANENT_HTTP_FAILURE",
      "SearchStax request failed.",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ContractError(
      "PERMANENT_HTTP_FAILURE",
      "SearchStax request failed.",
    );
  }
  if (isSearchStaxUndefinedFieldError(body, field)) return undefined;
  throw new ContractError(
    "PERMANENT_HTTP_FAILURE",
    "SearchStax request failed.",
  );
}

export function serializeUpsert(
  records: readonly PreparedRecord[],
): SearchStaxBatch {
  if (!records.length)
    throw new ContractError(
      "INVALID_BATCH",
      "SearchStax upsert batch was empty.",
    );
  const body = JSON.stringify(records.map((value) => value.document));
  return { records, body, byteSize: new TextEncoder().encode(body).byteLength };
}

export function createUpsertBatches(
  records: readonly PreparedRecord[],
): SearchStaxBatch[] {
  const result: SearchStaxBatch[] = [];
  let current: PreparedRecord[] = [];
  let serialized: string[] = [];
  let byteSize = 2;
  for (const item of records) {
    const body = JSON.stringify(item.document);
    const itemBytes = new TextEncoder().encode(body).byteLength;
    const candidateBytes = byteSize + itemBytes + (current.length ? 1 : 0);
    if (candidateBytes >= SEARCHSTAX_BODY_LIMIT_BYTES) {
      if (!current.length)
        throw new ContractError(
          "RECORD_TOO_LARGE",
          "SearchStax record exceeded the request limit.",
        );
      result.push({
        records: current,
        body: `[${serialized.join(",")}]`,
        byteSize,
      });
      current = [item];
      serialized = [body];
      byteSize = itemBytes + 2;
      if (byteSize >= SEARCHSTAX_BODY_LIMIT_BYTES)
        throw new ContractError(
          "RECORD_TOO_LARGE",
          "SearchStax record exceeded the request limit.",
        );
    } else {
      current.push(item);
      serialized.push(body);
      byteSize = candidateBytes;
    }
  }
  if (current.length)
    result.push({
      records: current,
      body: `[${serialized.join(",")}]`,
      byteSize,
    });
  return result;
}

export async function upsert(
  client: SearchStaxClient,
  batch: SearchStaxBatch,
  commit = false,
): Promise<void> {
  if (!batch.records.length || batch.byteSize >= SEARCHSTAX_BODY_LIMIT_BYTES)
    throw new ContractError(
      "INVALID_BATCH",
      "SearchStax upsert batch was invalid.",
    );
  const configured = settings(client);
  if (commit) configured.update.searchParams.set("commit", "true");
  await jsonRequest(client, configured.update, {
    method: "POST",
    headers: {
      authorization: `Token ${configured.token}`,
      "content-type": "application/json",
    },
    body: batch.body,
  });
}

export function isGeneratedDestinationId(id: string): boolean {
  return /^zdg_(?:[a-z0-9][a-z0-9-]*_\d+_[a-z0-9_]+|probe_[A-Za-z0-9_-]+)$/u.test(
    id,
  );
}

export function isSafeDestinationId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id);
}

function validateIds(
  ids: readonly string[],
  trustedManagedIds?: ReadonlySet<string>,
): void {
  if (
    !ids.length ||
    ids.length > 500 ||
    new Set(ids).size !== ids.length ||
    ids.some(
      (id) =>
        !isSafeDestinationId(id) ||
        (!isGeneratedDestinationId(id) && !trustedManagedIds?.has(id)),
    )
  ) {
    throw new ContractError(
      "INVALID_BATCH",
      "SearchStax exact-ID delete batch was invalid.",
    );
  }
}

export async function deleteExactIds(
  client: SearchStaxClient,
  ids: readonly string[],
  trustedManagedIds?: ReadonlySet<string>,
): Promise<void> {
  validateIds(ids, trustedManagedIds);
  const configured = settings(client);
  const command = new URL(configured.update);
  if (command.pathname.endsWith("/update/json/docs"))
    command.pathname = command.pathname.slice(0, -"/json/docs".length);
  command.searchParams.set("commit", "true");
  const query = [...ids]
    .sort()
    .map((id) => `id:"${id}"`)
    .join(" OR ");
  const body = JSON.stringify({ delete: { query } });
  if (new TextEncoder().encode(body).byteLength >= SEARCHSTAX_BODY_LIMIT_BYTES)
    throw new ContractError(
      "INVALID_BATCH",
      "SearchStax delete batch was too large.",
    );
  await jsonRequest(client, command, {
    method: "POST",
    headers: {
      authorization: `Token ${configured.token}`,
      "content-type": "application/json",
    },
    body,
  });
}

export async function selectExactId(
  client: SearchStaxClient,
  id: string,
): Promise<Record<string, Json> | null> {
  if (!isSafeDestinationId(id))
    throw new ContractError(
      "INVALID_BATCH",
      "SearchStax exact-ID input was invalid.",
    );
  const configured = settings(client);
  const url = new URL(configured.select);
  url.searchParams.set("q", `id:"${id}"`);
  url.searchParams.set("rows", "2");
  url.searchParams.set("wt", "json");
  const body = await jsonRequest(client, url, {
    headers: { authorization: `Token ${configured.token}` },
  });
  const response = record(
    body.response,
    "SearchStax select response was invalid.",
  );
  if (!Number.isSafeInteger(response.numFound) || !Array.isArray(response.docs))
    throw new ContractError(
      "INVALID_RESPONSE",
      "SearchStax select response was invalid.",
    );
  if (response.numFound === 0 && response.docs.length === 0) return null;
  if (response.numFound !== 1 || response.docs.length !== 1)
    throw new ContractError(
      "INVALID_RESPONSE",
      "SearchStax exact-ID query was not exact.",
    );
  const document = record(
    response.docs[0],
    "SearchStax document was invalid.",
  ) as Record<string, Json>;
  if (document.id !== id)
    throw new ContractError(
      "INVALID_RESPONSE",
      "SearchStax exact-ID query returned the wrong document.",
    );
  return document;
}

function visibilitySettings(client: SearchStaxClient) {
  const maxAttempts = client.visibilityMaxAttempts ?? 41;
  const pollMs = client.visibilityPollMs ?? 15_000;
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 41 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 0 ||
    pollMs > 60_000
  ) {
    throw new ContractError(
      "INVALID_CONFIGURATION",
      "SearchStax visibility polling was invalid.",
    );
  }
  return { maxAttempts, pollMs };
}

async function visibilitySleep(
  client: SearchStaxClient,
  milliseconds: number,
): Promise<void> {
  const remaining =
    client.deadlineAt === undefined
      ? Infinity
      : Math.max(0, client.deadlineAt - (client.now?.() ?? performance.now()));
  const delay = Math.min(milliseconds, remaining);
  if (client.sleep) await client.sleep(delay);
  else await new Promise((resolve) => setTimeout(resolve, delay));
}

export async function waitForExactId(
  client: SearchStaxClient,
  id: string,
): Promise<Record<string, Json>> {
  const { maxAttempts, pollMs } = visibilitySettings(client);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const actual = await selectExactId(client, id);
    if (actual) return actual;
    if (attempt < maxAttempts - 1) await visibilitySleep(client, pollMs);
  }
  throw new ContractError(
    "VISIBILITY_TIMEOUT",
    "SearchStax record did not become visible within the bounded wait.",
  );
}

export async function waitForExactIdAbsence(
  client: SearchStaxClient,
  id: string,
): Promise<void> {
  const { maxAttempts, pollMs } = visibilitySettings(client);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!(await selectExactId(client, id))) return;
    if (attempt < maxAttempts - 1) await visibilitySleep(client, pollMs);
  }
  throw new ContractError(
    "VISIBILITY_TIMEOUT",
    "SearchStax record remained visible after the bounded wait.",
  );
}

export function searchStaxFieldMatches(
  field: string,
  actual: Json | undefined,
  expected: Json,
): boolean {
  if (actual === undefined && Array.isArray(expected) && expected.length === 0)
    return true;
  if (
    actual === undefined &&
    expected === "" &&
    /^body_text_txt_[a-z0-9_]+$/u.test(field)
  )
    return true;
  if (JSON.stringify(actual) === JSON.stringify(expected)) return true;
  return (
    (field === "created_at_dt" || field === "updated_at_dt") &&
    typeof actual === "string" &&
    typeof expected === "string" &&
    Date.parse(actual) === Date.parse(expected)
  );
}

export async function assertConnectorKeyAvailable(
  client: SearchStaxClient,
  connectorKey: string,
  manifestIds: ReadonlySet<string>,
): Promise<void> {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(connectorKey)) {
    throw new ContractError(
      "INVALID_CONFIGURATION",
      "Connector key was invalid.",
    );
  }
  const configured = settings(client);
  const url = new URL(configured.select);
  url.searchParams.set("q", `connector_key_s:"${connectorKey}"`);
  url.searchParams.set("fl", "id");
  url.searchParams.set("rows", "501");
  url.searchParams.set("wt", "json");
  const body = await jsonRequest(client, url, {
    headers: { authorization: `Token ${configured.token}` },
  });
  const response = record(
    body.response,
    "SearchStax ownership response was invalid.",
  );
  if (
    !Number.isSafeInteger(response.numFound) ||
    !Array.isArray(response.docs) ||
    response.numFound !== response.docs.length ||
    response.numFound > 500
  ) {
    throw new ContractError(
      "INVALID_RESPONSE",
      "SearchStax ownership result was incomplete.",
    );
  }
  for (const value of response.docs) {
    const id = record(value, "SearchStax ownership document was invalid.").id;
    if (typeof id !== "string" || !manifestIds.has(id)) {
      throw new ContractError(
        "CONNECTOR_KEY_CONFLICT",
        "Connector key already exists outside the current manifest.",
      );
    }
  }
}

function ownedIdInventoryInput(
  client: SearchStaxClient,
  connectorKey: string,
  maxRecords: number,
) {
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(connectorKey) ||
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > 5_000
  )
    throw new ContractError(
      "INVALID_CONFIGURATION",
      "SearchStax destination inventory input was invalid.",
    );
  return settings(client);
}

export async function listOwnedIds(
  client: SearchStaxClient,
  connectorKey: string,
  maxRecords = 5_000,
  checkpoint?: () => Promise<void>,
): Promise<string[]> {
  const configured = ownedIdInventoryInput(client, connectorKey, maxRecords);
  const actual: string[] = [];
  const cursors = new Set<string>();
  let cursor = "*";
  let found: number | undefined;
  for (;;) {
    await checkpoint?.();
    cursors.add(cursor);
    const url = new URL(configured.select);
    url.searchParams.set("q", `connector_key_s:"${connectorKey}"`);
    url.searchParams.set("fl", "id");
    url.searchParams.set("rows", "500");
    url.searchParams.set("sort", "id asc");
    url.searchParams.set("cursorMark", cursor);
    url.searchParams.set("wt", "json");
    const body = await jsonRequest(client, url, {
      headers: { authorization: `Token ${configured.token}` },
    });
    const response = record(
      body.response,
      "SearchStax destination inventory response was invalid.",
    );
    if (
      !Number.isSafeInteger(response.numFound) ||
      (response.numFound as number) < 0 ||
      !Array.isArray(response.docs) ||
      response.docs.length > 500 ||
      (response.numFound as number) > maxRecords
    )
      throw new ContractError(
        "INVALID_RESPONSE",
        "SearchStax destination inventory response was invalid.",
      );
    const ids = response.docs.map(
      (value) =>
        record(value, "SearchStax destination inventory row was invalid.").id,
    );
    if (
      ids.some((id) => typeof id !== "string" || !id) ||
      new Set([...actual, ...(ids as string[])]).size !==
        actual.length + ids.length
    )
      throw new ContractError(
        "INVALID_RESPONSE",
        "SearchStax destination inventory response was invalid.",
      );
    found ??= response.numFound as number;
    if (response.numFound !== found)
      throw new ContractError(
        "INVALID_RESPONSE",
        "SearchStax destination inventory response was invalid.",
      );
    actual.push(...(ids as string[]));
    if (actual.length > found)
      throw new ContractError(
        "INVALID_RESPONSE",
        "SearchStax destination inventory response was invalid.",
      );
    const next = body.nextCursorMark;
    if (typeof next !== "string" || !next)
      throw new ContractError(
        "INVALID_RESPONSE",
        "SearchStax destination inventory response was invalid.",
      );
    if (actual.length === found) return actual.sort();
    if (next === cursor) {
      throw new ContractError(
        "INVALID_RESPONSE",
        "SearchStax destination inventory response was incomplete.",
      );
    }
    if (cursors.has(next))
      throw new ContractError(
        "INVALID_RESPONSE",
        "SearchStax destination inventory response was invalid.",
      );
    cursor = next;
  }
}

export async function listZendeskCandidates(
  client: SearchStaxClient,
  zendeskSubdomain: string,
  maxRecords = 5_000,
  checkpoint?: () => Promise<void>,
  sourceUrls: readonly string[] = [],
): Promise<SearchStaxCandidateDiscovery> {
  const normalizedSubdomain = zendeskSubdomain.trim().toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(normalizedSubdomain) ||
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > 5_000
  )
    throw new ContractError(
      "INVALID_CONFIGURATION",
      "SearchStax candidate discovery input was invalid.",
    );
  const configured = settings(client);
  const hosts = new Set([`${normalizedSubdomain}.zendesk.com`]);
  if (sourceUrls.length > maxRecords)
    throw new ContractError(
      "INVALID_CONFIGURATION",
      "SearchStax candidate discovery source URL evidence was too large.",
    );
  for (const value of sourceUrls) {
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !hostname ||
        hostname.includes(":")
      )
        continue;
      const labels = hostname.split(".");
      if (
        labels.some(
          (label) =>
            !label || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
        )
      )
        continue;
      hosts.add(hostname);
    } catch {
      // Invalid source URLs cannot be trusted as discovery evidence.
    }
  }
  if (hosts.size > 64)
    throw new ContractError(
      "INVALID_CONFIGURATION",
      "SearchStax candidate discovery source URL hosts were too many.",
    );
  const candidates = new Map<string, SearchStaxCandidate>();
  const fieldAvailability = {} as Record<
    SearchStaxCandidateUrlField,
    | { state: "queryable" }
    | { state: "unavailable"; reasonCode: "UNDEFINED_FIELD" }
  >;

  for (const field of SEARCHSTAX_CANDIDATE_URL_FIELDS) {
    let cursor = "*";
    let found: number | undefined;
    let fetchedRows = 0;
    const cursors = new Set<string>();
    for (;;) {
      await checkpoint?.();
      cursors.add(cursor);
      const url = new URL(configured.select);
      url.searchParams.set(
        "q",
        [...hosts]
          .sort((left, right) => left.localeCompare(right))
          .map((host) => `${field}:*${host}*`)
          .join(" OR "),
      );
      url.searchParams.set("fl", `id,${field}`);
      url.searchParams.set("rows", "500");
      url.searchParams.set("sort", "id asc");
      url.searchParams.set("cursorMark", cursor);
      url.searchParams.set("wt", "json");
      const body = await candidateJsonRequest(client, url, field);
      if (body === undefined) {
        fieldAvailability[field] = {
          state: "unavailable",
          reasonCode: "UNDEFINED_FIELD",
        };
        break;
      }
      fieldAvailability[field] = { state: "queryable" };
      const response = record(
        body.response,
        "SearchStax candidate inventory response was invalid.",
      );
      if (
        !Number.isSafeInteger(response.numFound) ||
        (response.numFound as number) < 0 ||
        !Array.isArray(response.docs) ||
        response.docs.length > 500 ||
        (response.numFound as number) > maxRecords
      )
        throw new ContractError(
          "INVALID_RESPONSE",
          "SearchStax candidate inventory response was incomplete.",
        );
      found ??= response.numFound as number;
      if (response.numFound !== found)
        throw new ContractError(
          "INVALID_RESPONSE",
          "SearchStax candidate inventory response was incomplete.",
        );
      fetchedRows += response.docs.length;
      if (fetchedRows > found)
        throw new ContractError(
          "INVALID_RESPONSE",
          "SearchStax candidate inventory response was invalid.",
        );
      for (const value of response.docs) {
        const document = record(
          value,
          "SearchStax candidate inventory row was invalid.",
        ) as Record<string, Json>;
        const id = document.id;
        if (typeof id !== "string" || !isSafeDestinationId(id))
          throw new ContractError(
            "INVALID_RESPONSE",
            "SearchStax candidate inventory contained an invalid destination ID.",
          );
        const fieldValue = document[field];
        const candidateDocument: Record<string, Json> = { id };
        if (fieldValue !== undefined) candidateDocument[field] = fieldValue;
        const prior = candidates.get(id);
        if (prior) {
          const priorValue = prior.document[field];
          if (
            priorValue !== undefined &&
            fieldValue !== undefined &&
            JSON.stringify(priorValue) !== JSON.stringify(fieldValue)
          )
            throw new ContractError(
              "INVALID_RESPONSE",
              "SearchStax candidate inventory contained conflicting duplicate IDs.",
            );
          candidates.set(id, {
            id,
            document: { ...prior.document, ...candidateDocument },
          });
        } else candidates.set(id, { id, document: candidateDocument });
        if (candidates.size > maxRecords)
          throw new ContractError(
            "INVALID_RESPONSE",
            "SearchStax candidate inventory exceeded the configured limit.",
          );
      }
      const next = body.nextCursorMark;
      if (typeof next !== "string" || !next)
        throw new ContractError(
          "INVALID_RESPONSE",
          "SearchStax candidate inventory response was incomplete.",
        );
      if (fetchedRows === found) break;
      if (next === cursor || cursors.has(next))
        throw new ContractError(
          "INVALID_RESPONSE",
          "SearchStax candidate inventory response was incomplete.",
        );
      cursor = next;
    }
  }
  if (
    SEARCHSTAX_CANDIDATE_URL_FIELDS.every(
      (field) => fieldAvailability[field].state === "unavailable",
    )
  )
    throw new ContractError(
      "NO_SUPPORTED_URL_FIELD",
      "SearchStax destination has no supported URL field.",
    );
  return {
    candidates: [...candidates.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    fieldAvailability,
  };
}

function parityInput(
  client: SearchStaxClient,
  connectorKey: string,
  expectedIds: readonly string[],
) {
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(connectorKey) ||
    expectedIds.length > 5_000 ||
    new Set(expectedIds).size !== expectedIds.length
  )
    throw new ContractError(
      "INVALID_CONFIGURATION",
      "SearchStax parity input was invalid.",
    );
  return {
    configured: settings(client),
    expected: [...expectedIds].sort(),
    ...visibilitySettings(client),
  };
}

export async function waitForOwnedIdParity(
  client: SearchStaxClient,
  connectorKey: string,
  expectedIds: readonly string[],
  checkpoint?: () => Promise<void>,
  optionalIds: readonly string[] = [],
): Promise<void> {
  const { expected, maxAttempts, pollMs } = parityInput(
    client,
    connectorKey,
    expectedIds,
  );
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const actual = await listOwnedIds(client, connectorKey, 5_000, checkpoint);
    const expectedSet = new Set(expected);
    const optionalSet = new Set(optionalIds);
    const actualSet = new Set(actual);
    if (
      expectedSet.size === expected.length &&
      optionalSet.size === optionalIds.length &&
      expected.every((id) => actualSet.has(id)) &&
      actual.every((id) => expectedSet.has(id) || optionalSet.has(id))
    )
      return;
    if (attempt < maxAttempts - 1) await visibilitySleep(client, pollMs);
  }
  throw new ContractError(
    "DESTINATION_PARITY_MISMATCH",
    "SearchStax connector-owned IDs did not reach exact parity.",
  );
}

export async function waitForSampledFields(
  client: SearchStaxClient,
  records: readonly PreparedRecord[],
  checkpoint?: () => Promise<void>,
): Promise<void> {
  const { maxAttempts, pollMs } = visibilitySettings(client);
  const sample = [...records]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 20);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let matched = true;
    for (const expectedRecord of sample) {
      await checkpoint?.();
      const actual = await selectExactId(client, expectedRecord.id);
      if (
        !actual ||
        Object.entries(expectedRecord.document).some(
          ([field, value]) =>
            !searchStaxFieldMatches(field, actual[field], value),
        )
      ) {
        matched = false;
        break;
      }
    }
    if (matched) return;
    if (attempt < maxAttempts - 1) await visibilitySleep(client, pollMs);
  }
  throw new ContractError(
    "DESTINATION_FIELD_MISMATCH",
    "SearchStax sampled fields did not match the expected document.",
  );
}

function probeDocument(id: string): Record<string, Json> {
  return {
    id,
    connector_key_s: "probe",
    source_system_s: "zendesk",
    source_type_s: "guide_article",
    source_brand_id_s: "0",
    source_brand_s: "Readiness probe",
    zendesk_article_id_s: "0",
    zendesk_translation_id_s: "0",
    locale_s: "en",
    title_txt_en: "Readiness probe",
    body_text_txt_en: "Readiness probe",
    url_s: "https://example.invalid/probe",
    created_at_dt: "2000-01-01T00:00:00.000Z",
    updated_at_dt: "2000-01-01T00:00:00.000Z",
    section_id_s: "0",
    section_name_s: "Probe",
    category_id_s: "0",
    category_name_s: "Probe",
    label_names_ss: [],
    promoted_b: false,
    outdated_b: false,
    visibility_s: "public",
  };
}

async function cleanupProbe(
  client: SearchStaxClient,
  store: PendingProbeStore,
  id: string,
  progress: (phase: ReadinessPhase) => void,
): Promise<void> {
  try {
    progress("deleting");
    await deleteExactIds(client, [id]);
    progress("confirming_cleanup");
    await waitForExactIdAbsence(client, id);
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    throw new ContractError(
      "PROBE_CLEANUP_UNCERTAIN",
      "SearchStax probe cleanup was not confirmed.",
    );
  }
  await store.clear(id);
}

export async function readinessProbe(
  client: SearchStaxClient,
  store: PendingProbeStore,
  randomId: () => string = () => crypto.randomUUID(),
  progress: (phase: ReadinessPhase) => void = () => undefined,
): Promise<void> {
  const cleanupClient = {
    ...client,
    deadlineAt: client.cleanupDeadlineAt ?? client.deadlineAt,
  };
  const pending = await store.get();
  if (pending) {
    progress("recovering_cleanup");
    await cleanupProbe(client, store, pending, progress);
  }
  if (
    client.deadlineAt !== undefined &&
    client.deadlineAt - (client.now?.() ?? performance.now()) <= 0
  )
    throw new ContractError(
      "READINESS_TIMEOUT",
      "SearchStax readiness validation timed out. Try again.",
    );
  const id = `zdg_probe_${randomId().replaceAll(/[^A-Za-z0-9_-]/gu, "")}`;
  await store.set(id);
  const document = probeDocument(id);
  const body = JSON.stringify([document]);
  const prepared = {
    id,
    document,
    canonical: body,
    hash: "probe",
    byteSize: new TextEncoder().encode(body).byteLength,
    warnings: [],
  } satisfies PreparedRecord;
  let failure: unknown;
  try {
    progress("writing");
    await upsert(client, serializeUpsert([prepared]), true);
    progress("waiting_for_visibility");
    const actual = await waitForExactId(client, id);
    for (const field of Object.keys(document)) {
      const actualValue = actual[field];
      const expectedValue = document[field];
      if (!searchStaxFieldMatches(field, actualValue, expectedValue))
        throw new ContractError(
          "INVALID_RESPONSE",
          `SearchStax readiness field ${field} was incompatible.`,
        );
    }
  } catch (error) {
    failure = error;
  }
  await cleanupProbe(cleanupClient, store, id, progress);
  if (
    failure instanceof ContractError &&
    ["REQUEST_DEADLINE", "VISIBILITY_TIMEOUT"].includes(failure.code)
  )
    throw new ContractError(
      "READINESS_TIMEOUT",
      "SearchStax readiness validation timed out. Try again.",
    );
  if (failure) throw failure;
}
