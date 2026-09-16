import { languageFields, normalizeLocale, type RecordInput } from "./record.ts";
import {
  ContractError,
  decimalString,
  record,
  requestWithRetry,
  requireJsonResponse,
  type RetryOptions,
} from "./shared.ts";

export interface ZendeskCredentials {
  accountSubdomain: string;
  email: string;
  apiToken: string;
}

/**
 * The OAuth credential shape is kept structural so worker contracts do not
 * depend on the runtime's token-storage module. The authorization provider is
 * responsible for supplying and rotating the bearer header.
 */
export interface ZendeskOAuthCredentials {
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

export type ZendeskAuthentication =
  ZendeskCredentials | ZendeskOAuthCredentials;

export interface ZendeskAuthorizationProvider {
  get(): Promise<string>;
  onUnauthorized(previousAuthorization: string): Promise<string>;
}

export interface Brand {
  id: string;
  name: string;
  subdomain: string;
}

export interface LocaleAvailability {
  locale: string;
  supported: boolean;
  reason?: string;
}

export interface SourceQuarantine {
  articleId: string;
  locale: string;
  publicTitle: string;
  publicUrl: string;
  reasonCode:
    "HIERARCHY_UNAVAILABLE" | "INVALID_HIERARCHY" | "INVALID_SOURCE_RECORD";
}

export interface ZendeskClient extends RetryOptions {
  credentials: ZendeskAuthentication;
  authorization?: ZendeskAuthorizationProvider;
  maxPages?: number;
}

function isOAuthCredentials(
  value: ZendeskAuthentication,
): value is ZendeskOAuthCredentials {
  return "kind" in value && value.kind === "oauth";
}

function subdomain(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(normalized)) {
    throw new ContractError(
      "INVALID_CONFIGURATION",
      "Zendesk subdomain was invalid.",
    );
  }
  return normalized;
}

function credentials(client: ZendeskClient): {
  origin: URL;
  authorization?: string;
  oauth: boolean;
} {
  const account = subdomain(client.credentials.accountSubdomain);
  if (isOAuthCredentials(client.credentials)) {
    return {
      origin: new URL(`https://${account}.zendesk.com`),
      oauth: true,
    };
  }
  const email = client.credentials.email.trim();
  const token = client.credentials.apiToken.trim();
  if (!email || !token)
    throw new ContractError(
      "INVALID_CONFIGURATION",
      "Zendesk credentials were incomplete.",
    );
  return {
    origin: new URL(`https://${account}.zendesk.com`),
    authorization: `Basic ${btoa(`${email}/token:${token}`)}`,
    oauth: false,
  };
}

async function authorization(
  client: ZendeskClient,
  auth: ReturnType<typeof credentials>,
): Promise<string> {
  client.signal?.throwIfAborted();
  if (
    client.deadlineAt !== undefined &&
    client.deadlineAt <= (client.now ?? (() => performance.now()))()
  )
    throw new ContractError(
      "REQUEST_DEADLINE",
      "Zendesk request deadline was reached.",
    );
  if (!client.authorization) {
    if (auth.oauth)
      throw new ContractError(
        "ZENDESK_AUTH_REQUIRED",
        "Zendesk authorization is required.",
      );
    return auth.authorization!;
  }
  try {
    const value = await client.authorization.get();
    if (typeof value !== "string" || !value.trim()) throw new Error();
    return value;
  } catch {
    throw new ContractError(
      "ZENDESK_AUTH_REQUIRED",
      "Zendesk authorization is required.",
    );
  }
}

async function authorizedGet(
  client: ZendeskClient,
  url: URL,
): Promise<Response> {
  const auth = credentials(client);
  let currentAuthorization = await authorization(client, auth);
  const request = (header: string) =>
    requestWithRetry(
      url,
      {
        headers: {
          accept: "application/json",
          authorization: header,
        },
      },
      client,
      "Zendesk",
    );

  let response = await request(currentAuthorization);
  if (response.status === 401 && client.authorization) {
    await response.body?.cancel().catch(() => undefined);
    client.signal?.throwIfAborted();
    if (
      client.deadlineAt !== undefined &&
      client.deadlineAt <= (client.now ?? (() => performance.now()))()
    )
      throw new ContractError(
        "REQUEST_DEADLINE",
        "Zendesk request deadline was reached.",
      );
    try {
      const refreshed =
        await client.authorization.onUnauthorized(currentAuthorization);
      if (typeof refreshed !== "string" || !refreshed.trim()) throw new Error();
      currentAuthorization = refreshed;
    } catch {
      throw new ContractError(
        "ZENDESK_AUTH_REQUIRED",
        "Zendesk authorization is required.",
      );
    }
    response = await request(currentAuthorization);
  }

  if (client.authorization && response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    throw new ContractError(
      "ZENDESK_AUTH_REQUIRED",
      "Zendesk authorization is required.",
    );
  }
  if (client.authorization && response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new ContractError(
      "ZENDESK_SCOPE_REQUIRED",
      "Zendesk authorization scope is insufficient.",
    );
  }
  return response;
}

async function getJson(
  client: ZendeskClient,
  url: URL,
): Promise<Record<string, unknown>> {
  const auth = credentials(client);
  if (url.protocol !== "https:" || url.origin !== auth.origin.origin) {
    throw new ContractError(
      "UNSAFE_CONTINUATION",
      "Zendesk URL was outside the selected account origin.",
    );
  }
  const response = await authorizedGet(client, url);
  return record(
    await requireJsonResponse(response, "Zendesk"),
    "Zendesk response was invalid.",
  );
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new ContractError("INVALID_RESPONSE", `Zendesk ${name} was invalid.`);
  return value.trim();
}

function contentString(value: unknown, name: string): string {
  if (typeof value !== "string")
    throw new ContractError("INVALID_RESPONSE", `Zendesk ${name} was invalid.`);
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw new ContractError("INVALID_RESPONSE", `Zendesk ${name} was invalid.`);
  return value;
}

function quarantineReason(
  error: ContractError,
): SourceQuarantine["reasonCode"] {
  if (error.code.startsWith("ZENDESK_HIERARCHY_"))
    return "HIERARCHY_UNAVAILABLE";
  if (error.code === "INVALID_HIERARCHY") return "INVALID_HIERARCHY";
  return "INVALID_SOURCE_RECORD";
}

function issueContext(
  brand: Brand,
  requestedLocale: string,
  articleId: string,
  translation: Record<string, unknown>,
) {
  const publicTitle =
    typeof translation.title === "string" && translation.title.trim()
      ? translation.title.trim()
      : `Zendesk article ${articleId}`;
  let publicUrl: string;
  try {
    const candidate = new URL(String(translation.html_url));
    if (
      candidate.protocol !== "https:" ||
      candidate.username ||
      candidate.password
    )
      throw new Error();
    publicUrl = candidate.toString();
  } catch {
    publicUrl = new URL(
      `/hc/${encodeURIComponent(requestedLocale)}/articles/${articleId}`,
      `https://${brand.subdomain}.zendesk.com`,
    ).toString();
  }
  return { publicTitle, publicUrl };
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value))
    throw new ContractError("INVALID_RESPONSE", `Zendesk ${name} was invalid.`);
  return value;
}

function safeContinuation(origin: URL, value: unknown): URL {
  if (typeof value !== "string")
    throw new ContractError(
      "INVALID_RESPONSE",
      "Zendesk pagination continuation was missing.",
    );
  let next: URL;
  try {
    next = new URL(value);
  } catch {
    throw new ContractError(
      "UNSAFE_CONTINUATION",
      "Zendesk pagination continuation was invalid.",
    );
  }
  if (next.protocol !== "https:" || next.origin !== origin.origin)
    throw new ContractError(
      "UNSAFE_CONTINUATION",
      "Zendesk pagination continuation was unsafe.",
    );
  return next;
}

async function* cursorPages(
  client: ZendeskClient,
  first: URL,
): AsyncIterable<Record<string, unknown>> {
  const origin = credentials(client).origin;
  let next: URL | null = first;
  const seen = new Set<string>();
  let count = 0;
  while (next !== null) {
    count += 1;
    if (count > (client.maxPages ?? 10_000))
      throw new ContractError(
        "NONTERMINAL_PAGINATION",
        "Zendesk pagination did not terminate.",
      );
    if (seen.has(next.href))
      throw new ContractError(
        "REPEATED_CURSOR",
        "Zendesk pagination repeated a cursor.",
      );
    seen.add(next.href);
    const page = await getJson(client, next);
    const meta = record(page.meta, "Zendesk pagination metadata was invalid.");
    const links = record(page.links, "Zendesk pagination links were invalid.");
    const hasMore = boolean(meta.has_more, "pagination metadata");
    if (hasMore) next = safeContinuation(origin, links.next);
    else next = null;
    yield page;
  }
}

export async function discoverBrands(client: ZendeskClient): Promise<Brand[]> {
  const origin = credentials(client).origin;
  const result: Brand[] = [];
  for await (const page of cursorPages(
    client,
    new URL("/api/v2/brands.json?page[size]=100", origin),
  )) {
    for (const value of array(page.brands, "brands")) {
      const brand = record(value, "Zendesk brand was invalid.");
      if (
        boolean(brand.active, "brand active state") &&
        boolean(brand.has_help_center, "brand Help Center state")
      ) {
        result.push({
          id: decimalString(brand.id, "Zendesk brand id"),
          name: string(brand.name, "brand name"),
          subdomain: subdomain(string(brand.subdomain, "brand subdomain")),
        });
      }
    }
  }
  return result;
}

function brandUrl(client: ZendeskClient, brand: Brand, pathname: string): URL {
  const account = credentials(client).origin;
  const url = new URL(pathname, `https://${brand.subdomain}.zendesk.com`);
  // Requests use the account API origin for credentials but a selected brand may
  // have its own host. Make that one explicit exception, never a continuation.
  if (
    url.protocol !== "https:" ||
    (url.origin !== account.origin &&
      url.hostname !== `${brand.subdomain}.zendesk.com`)
  ) {
    throw new ContractError(
      "INVALID_CONFIGURATION",
      "Zendesk brand origin was invalid.",
    );
  }
  return url;
}

async function getBrandResponse(
  client: ZendeskClient,
  brand: Brand,
  url: URL,
  requestKind: "LOCALES" | "ARTICLES" | "HIERARCHY",
): Promise<Response> {
  const expectedOrigin = `https://${brand.subdomain}.zendesk.com`;
  if (url.protocol !== "https:" || url.origin !== expectedOrigin)
    throw new ContractError(
      "UNSAFE_CONTINUATION",
      "Zendesk brand continuation was unsafe.",
    );
  try {
    return await authorizedGet(client, url);
  } catch (error) {
    if (
      error instanceof ContractError &&
      ([
        "REQUEST_FAILED",
        "REQUEST_TIMEOUT",
        "FETCH_REJECTED",
        "REDIRECT_REFUSED",
      ].includes(error.code) ||
        /^REQUEST_REJECTED_[TFLEV]{3}$/u.test(error.code) ||
        /^REQUEST_ATTEMPTS_[RTFLEV]{2}[TFLEV]$/u.test(error.code))
    ) {
      throw new ContractError(
        `ZENDESK_${requestKind}_${error.code}`,
        error.message,
      );
    }
    throw error;
  }
}

function rethrowReturnedHttpFailure(
  error: unknown,
  requestKind: "LOCALES" | "ARTICLES" | "HIERARCHY",
): never {
  if (
    error instanceof ContractError &&
    ["PERMANENT_HTTP_FAILURE", "TRANSIENT_HTTP_FAILURE"].includes(error.code)
  ) {
    throw new ContractError(
      `ZENDESK_${requestKind}_${error.code}`,
      error.message,
    );
  }
  throw error;
}

async function getBrandJson(
  client: ZendeskClient,
  brand: Brand,
  url: URL,
  requestKind: "LOCALES" | "ARTICLES",
): Promise<Record<string, unknown>> {
  const response = await getBrandResponse(client, brand, url, requestKind);
  try {
    return record(
      await requireJsonResponse(response, "Zendesk"),
      "Zendesk response was invalid.",
    );
  } catch (error) {
    rethrowReturnedHttpFailure(error, requestKind);
  }
}

async function* brandPages(
  client: ZendeskClient,
  brand: Brand,
  first: URL,
): AsyncIterable<Record<string, unknown>> {
  let next: URL | null = first;
  const seen = new Set<string>();
  let count = 0;
  while (next) {
    count += 1;
    if (count > (client.maxPages ?? 10_000))
      throw new ContractError(
        "NONTERMINAL_PAGINATION",
        "Zendesk pagination did not terminate.",
      );
    if (seen.has(next.href))
      throw new ContractError(
        "REPEATED_CURSOR",
        "Zendesk pagination repeated a cursor.",
      );
    seen.add(next.href);
    const page = await getBrandJson(client, brand, next, "ARTICLES");
    const meta = record(page.meta, "Zendesk pagination metadata was invalid.");
    const links = record(page.links, "Zendesk pagination links were invalid.");
    if (boolean(meta.has_more, "pagination metadata")) {
      next = safeContinuation(
        new URL(`https://${brand.subdomain}.zendesk.com`),
        links.next,
      );
    } else next = null;
    yield page;
  }
}

export async function discoverLocales(
  client: ZendeskClient,
  brand: Brand,
): Promise<LocaleAvailability[]> {
  const response = await getBrandJson(
    client,
    brand,
    brandUrl(client, brand, "/api/v2/help_center/locales.json"),
    "LOCALES",
  );
  return array(response.locales, "locales").map((value) => {
    const locale = string(value, "locale");
    try {
      languageFields(locale);
      return { locale, supported: true };
    } catch (error) {
      if (
        !(error instanceof ContractError) ||
        error.code !== "UNSUPPORTED_LOCALE"
      )
        throw error;
      return {
        locale,
        supported: false,
        reason: "No approved SearchStax language field mapping.",
      };
    }
  });
}

function publicArticle(article: Record<string, unknown>): boolean {
  const modern = article.user_segment_ids;
  if (modern !== undefined && !Array.isArray(modern))
    throw new ContractError(
      "INVALID_RESPONSE",
      "Zendesk user segment list was invalid.",
    );
  if (Array.isArray(modern) && modern.length > 0) return false;
  if (article.user_segment_id !== undefined && article.user_segment_id !== null)
    return false;
  for (const field of ["draft", "archived"] as const) {
    if (article[field] !== undefined && typeof article[field] !== "boolean")
      throw new ContractError(
        "INVALID_RESPONSE",
        `Zendesk article ${field} state was invalid.`,
      );
  }
  return article.draft !== true && article.archived !== true;
}

async function hierarchy(
  client: ZendeskClient,
  brand: Brand,
  page: Record<string, unknown>,
  article: Record<string, unknown>,
  locale: string,
  requestedLocale: string,
) {
  const sectionId = decimalString(article.section_id, "Zendesk section id");
  const sections = array(page.sections, "sections").map((value) =>
    record(value, "Zendesk section was invalid."),
  );
  const localizedSection = sections.find(
    (value) =>
      decimalString(value.id, "Zendesk section id") === sectionId &&
      normalizeLocale(string(value.locale, "section locale")) === locale,
  );

  const exactHierarchy = async (
    kind: "categories" | "sections",
    id: string,
    pathLocale?: string,
  ): Promise<Record<string, unknown> | null> => {
    const singular = kind === "sections" ? "section" : "category";
    const response = await getBrandResponse(
      client,
      brand,
      brandUrl(
        client,
        brand,
        `/api/v2/help_center/${pathLocale ? `${encodeURIComponent(pathLocale)}/` : ""}${kind}/${id}.json`,
      ),
      "HIERARCHY",
    );
    if (pathLocale && response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    let body: Record<string, unknown>;
    try {
      body = record(
        await requireJsonResponse(response, "Zendesk"),
        "Zendesk response was invalid.",
      );
    } catch (error) {
      rethrowReturnedHttpFailure(error, "HIERARCHY");
    }
    const value = record(body[singular], `Zendesk ${singular} was invalid.`);
    if (
      decimalString(value.id, `Zendesk ${singular} id`) !== id ||
      (pathLocale &&
        normalizeLocale(string(value.locale, `${singular} locale`)) !== locale)
    ) {
      throw new ContractError(
        "INVALID_HIERARCHY",
        `Zendesk ${singular} did not match.`,
      );
    }
    if (!pathLocale) string(value.locale, `${singular} locale`);
    return value;
  };

  const section =
    localizedSection ??
    (await exactHierarchy("sections", sectionId, requestedLocale)) ??
    (await exactHierarchy("sections", sectionId));
  if (!section)
    throw new ContractError(
      "INVALID_HIERARCHY",
      "Zendesk section was missing.",
    );
  const categoryId = decimalString(section.category_id, "Zendesk category id");
  const categories = array(page.categories, "categories").map((value) =>
    record(value, "Zendesk category was invalid."),
  );
  const localizedCategory = categories.find(
    (value) =>
      decimalString(value.id, "Zendesk category id") === categoryId &&
      normalizeLocale(string(value.locale, "category locale")) === locale,
  );
  const category =
    localizedCategory ??
    (await exactHierarchy("categories", categoryId, requestedLocale)) ??
    (await exactHierarchy("categories", categoryId));
  if (!category)
    throw new ContractError(
      "INVALID_HIERARCHY",
      "Zendesk category was missing.",
    );

  return {
    sectionId,
    sectionName: string(section.name, "section name"),
    categoryId,
    categoryName: string(category.name, "category name"),
  };
}

export async function listEligibleTranslations(
  client: ZendeskClient,
  brand: Brand,
  requestedLocale: string,
  options: {
    limit?: number;
    articleId?: string;
    checkpoint?: () => Promise<void>;
    onQuarantine?: (record: SourceQuarantine) => void;
  } = {},
): Promise<RecordInput[]> {
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit < 1)
  )
    throw new ContractError(
      "INVALID_CONFIGURATION",
      "Source limit was invalid.",
    );
  const locale = languageFields(requestedLocale).normalizedLocale;
  const first = brandUrl(
    client,
    brand,
    `/api/v2/help_center/${encodeURIComponent(requestedLocale)}/articles.json?page[size]=100&include=sections,categories,translations`,
  );
  const result: RecordInput[] = [];
  const seen = new Set<string>();
  for await (const page of brandPages(client, brand, first)) {
    await options.checkpoint?.();
    for (const value of array(page.articles, "articles")) {
      await options.checkpoint?.();
      const article = record(value, "Zendesk article was invalid.");
      if (options.articleId === undefined) {
        if (!publicArticle(article)) continue;
      } else {
        const candidateId = decimalString(article.id, "Zendesk article id");
        if (candidateId !== options.articleId) continue;
        if (!publicArticle(article)) return result;
      }
      if (normalizeLocale(string(article.locale, "article locale")) !== locale)
        throw new ContractError(
          "INVALID_RESPONSE",
          "Zendesk article locale was invalid.",
        );
      const articleId =
        options.articleId ?? decimalString(article.id, "Zendesk article id");
      if (seen.has(articleId))
        throw new ContractError(
          "DUPLICATE_ARTICLE",
          "Zendesk repeated an article.",
        );
      seen.add(articleId);
      const translations = array(article.translations, "translations")
        .map((entry) => record(entry, "Zendesk translation was invalid."))
        .filter(
          (entry) =>
            normalizeLocale(string(entry.locale, "translation locale")) ===
            locale,
        );
      if (translations.length > 1)
        throw new ContractError(
          "INVALID_RESPONSE",
          "Zendesk returned duplicate locale translations.",
        );
      const translation = translations[0];
      if (!translation || translation.draft === true) {
        if (options.articleId !== undefined) return result;
        continue;
      }
      if (typeof translation.draft !== "boolean")
        throw new ContractError(
          "INVALID_RESPONSE",
          "Zendesk translation draft state was invalid.",
        );
      try {
        const names = await hierarchy(
          client,
          brand,
          page,
          article,
          locale,
          requestedLocale,
        );
        const labels = array(article.label_names, "article labels").map(
          (label) => string(label, "article label"),
        );
        result.push({
          connectorKey: "pending",
          brandId: brand.id,
          brandName: brand.name,
          articleId,
          translationId: decimalString(
            translation.id,
            "Zendesk translation id",
          ),
          locale,
          title: string(translation.title, "translation title"),
          bodyHtml:
            translation.body === null
              ? null
              : contentString(translation.body, "translation body"),
          url: string(translation.html_url, "translation URL"),
          createdAt: string(article.created_at, "article created date"),
          updatedAt: string(translation.updated_at, "translation updated date"),
          ...names,
          labels,
          promoted: boolean(article.promoted, "article promoted state"),
          outdated: boolean(translation.outdated, "translation outdated state"),
        });
      } catch (error) {
        // Authentication and scope failures invalidate the source inventory;
        // they must reach reconciliation instead of becoming quarantined
        // records that could authorize deletion.
        if (
          error instanceof ContractError &&
          ["ZENDESK_AUTH_REQUIRED", "ZENDESK_SCOPE_REQUIRED"].includes(
            error.code,
          )
        )
          throw error;
        if (!(error instanceof ContractError) || !options.onQuarantine)
          throw error;
        options.onQuarantine({
          articleId,
          locale,
          ...issueContext(brand, requestedLocale, articleId, translation),
          reasonCode: quarantineReason(error),
        });
        if (options.articleId !== undefined) return result;
        continue;
      }
      if (options.articleId !== undefined) return result;
      // A limit is only for the bounded diagnostic harness. Its result is not
      // authoritative for absence and must never drive reconciliation.
      if (result.length === options.limit) return result;
    }
  }
  return result;
}

export function withConnectorKey(
  records: readonly RecordInput[],
  connectorKey: string,
): RecordInput[] {
  return records.map((value) => ({ ...value, connectorKey }));
}
