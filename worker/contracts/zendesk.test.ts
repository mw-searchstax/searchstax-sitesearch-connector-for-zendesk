import { describe, expect, it, vi } from "vitest";

import {
  discoverBrands,
  discoverLocales,
  listEligibleTranslations,
  withConnectorKey,
  type Brand,
  type ZendeskClient,
} from "./zendesk.ts";

function json(
  value: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function scripted(
  steps: readonly ((request: Request) => Response | Promise<Response>)[],
) {
  let index = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const step = steps[index++];
    if (!step) throw new Error(`Unmatched network request: ${String(input)}`);
    return step(new Request(input, init));
  });
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    done: () => expect(index).toBe(steps.length),
  };
}

function client(
  fetch: typeof globalThis.fetch,
  extra: Partial<ZendeskClient> = {},
): ZendeskClient {
  return {
    credentials: {
      accountSubdomain: "account",
      email: "operator@example.com",
      apiToken: "secret",
    },
    fetch,
    sleep: vi.fn(async () => undefined),
    ...extra,
  };
}

function oauthClient(
  fetch: typeof globalThis.fetch,
  authorization: NonNullable<ZendeskClient["authorization"]>,
  extra: Partial<ZendeskClient> = {},
): ZendeskClient {
  return client(fetch, {
    credentials: {
      kind: "oauth",
      accountSubdomain: "account",
      clientId: "client",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessExpiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 3_600_000,
      generation: 1,
      scopes: ["read"],
    },
    authorization,
    ...extra,
  });
}

const brand: Brand = { id: "10", name: "Docs", subdomain: "docs" };

describe("Zendesk authenticated source", () => {
  it("discovers only active Help Center brands across cursor pages", async () => {
    const mock = scripted([
      (request) => {
        expect(request.url).toBe(
          "https://account.zendesk.com/api/v2/brands.json?page[size]=100",
        );
        expect(request.headers.get("accept")).toBe("application/json");
        expect(request.headers.get("authorization")).toMatch(/^Basic /u);
        return json({
          brands: [
            {
              id: 10,
              name: "Docs",
              subdomain: "docs",
              active: true,
              has_help_center: true,
            },
            {
              id: 11,
              name: "Off",
              subdomain: "off",
              active: false,
              has_help_center: true,
            },
          ],
          meta: { has_more: true },
          links: {
            next: "https://account.zendesk.com/api/v2/brands.json?page%5Bafter%5D=abc",
          },
        });
      },
      () =>
        json({
          brands: [
            {
              id: "12",
              name: "No HC",
              subdomain: "no-hc",
              active: true,
              has_help_center: false,
            },
          ],
          meta: { has_more: false },
          links: { next: null },
        }),
    ]);
    await expect(discoverBrands(client(mock.fetch))).resolves.toEqual([brand]);
    mock.done();
  });

  it("renews a bearer authorization once when a later cursor page returns 401", async () => {
    const get = vi
      .fn<NonNullable<ZendeskClient["authorization"]>["get"]>()
      .mockResolvedValue("Bearer old");
    const onUnauthorized = vi
      .fn<NonNullable<ZendeskClient["authorization"]>["onUnauthorized"]>()
      .mockImplementation(async (previousAuthorization) => {
        expect(previousAuthorization).toBe("Bearer old");
        get.mockResolvedValue("Bearer new");
        return "Bearer new";
      });
    const mock = scripted([
      (request) => {
        expect(request.url).toBe(
          "https://account.zendesk.com/api/v2/brands.json?page[size]=100",
        );
        expect(request.headers.get("authorization")).toBe("Bearer old");
        return json({
          brands: [],
          meta: { has_more: true },
          links: {
            next: "https://account.zendesk.com/api/v2/brands.json?page%5Bafter%5D=next",
          },
        });
      },
      (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer old");
        return json({}, 401);
      },
      (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer new");
        return json({
          brands: [
            {
              id: 10,
              name: "Docs",
              subdomain: "docs",
              active: true,
              has_help_center: true,
            },
          ],
          meta: { has_more: false },
          links: { next: null },
        });
      },
    ]);

    await expect(
      discoverBrands(oauthClient(mock.fetch, { get, onUnauthorized })),
    ).resolves.toEqual([brand]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    mock.done();
  });

  it("classifies a terminal OAuth 401 without retrying beyond the single replay", async () => {
    const authorization = {
      get: vi.fn(async () => "Bearer expired"),
      onUnauthorized: vi.fn(async () => "Bearer still-expired"),
    };
    const mock = scripted([() => json({}, 401), () => json({}, 401)]);

    await expect(
      discoverLocales(oauthClient(mock.fetch, authorization), brand),
    ).rejects.toMatchObject({
      code: "ZENDESK_AUTH_REQUIRED",
      message: "Zendesk authorization is required.",
    });
    expect(authorization.onUnauthorized).toHaveBeenCalledTimes(1);
    mock.done();
  });

  it("classifies OAuth 403 as a scope failure without refreshing", async () => {
    const authorization = {
      get: vi.fn(async () => "Bearer insufficient"),
      onUnauthorized: vi.fn(async () => "Bearer never-used"),
    };
    const mock = scripted([() => json({}, 403)]);

    await expect(
      discoverLocales(oauthClient(mock.fetch, authorization), brand),
    ).rejects.toMatchObject({
      code: "ZENDESK_SCOPE_REQUIRED",
      message: "Zendesk authorization scope is insufficient.",
    });
    expect(authorization.onUnauthorized).not.toHaveBeenCalled();
    mock.done();
  });

  it("does not expose bearer authorization to a foreign pagination origin", async () => {
    const authorization = {
      get: vi.fn(async () => "Bearer private"),
      onUnauthorized: vi.fn(async () => "Bearer refreshed"),
    };
    const mock = scripted([
      () =>
        json({
          brands: [],
          meta: { has_more: true },
          links: { next: "https://foreign.example/api/v2/brands.json" },
        }),
    ]);

    await expect(
      discoverBrands(oauthClient(mock.fetch, authorization)),
    ).rejects.toThrow(/unsafe/u);
    expect(authorization.get).toHaveBeenCalledTimes(1);
    expect(authorization.onUnauthorized).not.toHaveBeenCalled();
    mock.done();
  });

  it("propagates OAuth hierarchy auth failure instead of quarantining the article", async () => {
    const authorization = {
      get: vi.fn(async () => "Bearer expired"),
      onUnauthorized: vi.fn(async () => "Bearer still-expired"),
    };
    const mock = scripted([
      () =>
        json({
          articles: [
            {
              id: 20,
              locale: "en-US",
              draft: false,
              archived: false,
              user_segment_ids: [],
              user_segment_id: null,
              created_at: "2025-01-01T00:00:00Z",
              section_id: 40,
              label_names: [],
              promoted: false,
              translations: [
                {
                  id: 30,
                  locale: "en-US",
                  draft: false,
                  title: "Hello",
                  body: "Body",
                  html_url: "https://docs.example/a",
                  updated_at: "2025-01-02T00:00:00Z",
                  outdated: false,
                },
              ],
            },
          ],
          sections: [],
          categories: [],
          meta: { has_more: false },
          links: { next: null },
        }),
      () => json({}, 401),
      () => json({}, 401),
    ]);
    const quarantined: unknown[] = [];

    await expect(
      listEligibleTranslations(
        oauthClient(mock.fetch, authorization),
        brand,
        "en-US",
        {
          onQuarantine: (record) => quarantined.push(record),
        },
      ),
    ).rejects.toMatchObject({ code: "ZENDESK_AUTH_REQUIRED" });
    expect(quarantined).toEqual([]);
    mock.done();
  });

  it("shows unsupported locales but marks them unavailable", async () => {
    const mock = scripted([
      (request) => {
        expect(request.url).toBe(
          "https://docs.zendesk.com/api/v2/help_center/locales.json",
        );
        return json({ locales: ["en-US", "fr-FR", "es-419"] });
      },
    ]);
    await expect(discoverLocales(client(mock.fetch), brand)).resolves.toEqual([
      { locale: "en-US", supported: true },
      {
        locale: "fr-FR",
        supported: false,
        reason: "No approved SearchStax language field mapping.",
      },
      { locale: "es-419", supported: true },
    ]);
    mock.done();
  });

  it("retains the article request locus for a fetch rejection", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("private fetch detail");
    }) as unknown as typeof globalThis.fetch;

    await expect(
      listEligibleTranslations(client(fetch), brand, "en-US"),
    ).rejects.toMatchObject({
      code: "ZENDESK_ARTICLES_FETCH_REJECTED",
      message: "Zendesk fetch was rejected.",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retains the article request locus for a returned HTTP failure", async () => {
    const mock = scripted([() => json({}, 401)]);

    await expect(
      listEligibleTranslations(client(mock.fetch), brand, "en-US"),
    ).rejects.toMatchObject({
      code: "ZENDESK_ARTICLES_PERMANENT_HTTP_FAILURE",
      message: "Zendesk request failed.",
    });
    mock.done();
  });

  it("fails closed when an eligible article omits embedded translations", async () => {
    const mock = scripted([
      () =>
        json({
          articles: [
            {
              id: 20,
              locale: "en-US",
              draft: false,
              archived: false,
              user_segment_ids: [],
              user_segment_id: null,
              created_at: "2025-01-01T00:00:00Z",
              section_id: 40,
              label_names: [],
              promoted: false,
            },
          ],
          sections: [],
          categories: [],
          meta: { has_more: false },
          links: { next: null },
        }),
    ]);
    await expect(
      listEligibleTranslations(client(mock.fetch), brand, "en-US"),
    ).rejects.toThrow(/translations was invalid/u);
    mock.done();
  });

  it("enumerates a complete locale, excludes both user-segment shapes, and resolves localized hierarchy", async () => {
    const base = {
      locale: "en-US",
      created_at: "2025-01-01T00:00:00Z",
      section_id: 40,
      label_names: ["z", "a"],
      promoted: false,
    };
    const mock = scripted([
      (request) => {
        expect(request.url).toBe(
          "https://docs.zendesk.com/api/v2/help_center/en-US/articles.json?page[size]=100&include=sections,categories,translations",
        );
        expect(request.headers.get("accept")).toBe("application/json");
        return json({
          articles: [
            {
              ...base,
              id: 20,
              draft: false,
              archived: false,
              user_segment_ids: [],
              user_segment_id: null,
              translations: [
                {
                  id: 30,
                  locale: "en-US",
                  draft: false,
                  title: "Hello",
                  body: "",
                  html_url: "https://docs.example.com/a",
                  updated_at: "2025-01-02T00:00:00Z",
                  outdated: false,
                },
              ],
            },
            { ...base, id: 21, user_segment_ids: [7] },
            { ...base, id: 22, user_segment_id: 8 },
            { ...base, id: 23, draft: true },
            { ...base, id: 24, archived: true },
          ],
          sections: [
            { id: 40, locale: "en-US", name: "Start", category_id: 50 },
          ],
          categories: [{ id: 50, locale: "en-US", name: "Help" }],
          meta: { has_more: false },
          links: { next: null },
        });
      },
    ]);
    const records = await listEligibleTranslations(
      client(mock.fetch),
      brand,
      "en-US",
    );
    expect(withConnectorKey(records, "docs-main")).toEqual([
      {
        connectorKey: "docs-main",
        brandId: "10",
        brandName: "Docs",
        articleId: "20",
        translationId: "30",
        locale: "en_us",
        title: "Hello",
        bodyHtml: "",
        url: "https://docs.example.com/a",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-02T00:00:00Z",
        sectionId: "40",
        sectionName: "Start",
        categoryId: "50",
        categoryName: "Help",
        labels: ["z", "a"],
        promoted: false,
        outdated: false,
      },
    ]);
    mock.done();
  });

  it("falls back to exact localized hierarchy lookups when sideloads omit it", async () => {
    const mock = scripted([
      () =>
        json({
          articles: [
            {
              id: 20,
              locale: "es-419",
              created_at: "2025-01-01T00:00:00Z",
              section_id: 40,
              label_names: [],
              promoted: false,
              draft: false,
              archived: false,
              user_segment_ids: [],
              user_segment_id: null,
              translations: [
                {
                  id: 30,
                  locale: "es-419",
                  draft: false,
                  title: "Hola",
                  body: "Cuerpo",
                  html_url: "https://docs.example.com/es",
                  updated_at: "2025-01-02T00:00:00Z",
                  outdated: false,
                },
              ],
            },
          ],
          sections: [],
          categories: [],
          meta: { has_more: false },
          links: { next: null },
        }),
      (request) => {
        expect(request.url).toBe(
          "https://docs.zendesk.com/api/v2/help_center/es-419/sections/40.json",
        );
        return json({
          section: {
            id: 40,
            locale: "es-419",
            name: "Inicio",
            category_id: 50,
          },
        });
      },
      (request) => {
        expect(request.url).toBe(
          "https://docs.zendesk.com/api/v2/help_center/es-419/categories/50.json",
        );
        return json({
          category: {
            id: 50,
            locale: "es-419",
            name: "Ayuda",
          },
        });
      },
    ]);

    const [record] = await listEligibleTranslations(
      client(mock.fetch),
      brand,
      "es-419",
      { limit: 1 },
    );
    expect(record).toMatchObject({
      sectionName: "Inicio",
      categoryName: "Ayuda",
    });
    mock.done();
  });

  it("retains the hierarchy request locus for a returned HTTP failure", async () => {
    const mock = scripted([
      () =>
        json({
          articles: [
            {
              id: 20,
              locale: "en-US",
              created_at: "2025-01-01T00:00:00Z",
              section_id: 40,
              label_names: [],
              promoted: false,
              draft: false,
              archived: false,
              user_segment_ids: [],
              user_segment_id: null,
              translations: [
                {
                  id: 30,
                  locale: "en-US",
                  draft: false,
                  title: "Hello",
                  body: "Body",
                  html_url: "https://docs.example.com/a",
                  updated_at: "2025-01-02T00:00:00Z",
                  outdated: false,
                },
              ],
            },
          ],
          sections: [],
          categories: [],
          meta: { has_more: false },
          links: { next: null },
        }),
      () => json({}, 401),
    ]);

    await expect(
      listEligibleTranslations(client(mock.fetch), brand, "en-US"),
    ).rejects.toMatchObject({
      code: "ZENDESK_HIERARCHY_PERMANENT_HTTP_FAILURE",
      message: "Zendesk request failed.",
    });
    mock.done();
  });

  it("uses exact base hierarchy only when localized resources are absent", async () => {
    const mock = scripted([
      () =>
        json({
          articles: [
            {
              id: 20,
              locale: "es-419",
              created_at: "2025-01-01T00:00:00Z",
              section_id: 40,
              label_names: [],
              promoted: false,
              draft: false,
              archived: false,
              user_segment_ids: [],
              user_segment_id: null,
              translations: [
                {
                  id: 30,
                  locale: "es-419",
                  draft: false,
                  title: "Hola",
                  body: "Cuerpo",
                  html_url: "https://docs.example.com/es",
                  updated_at: "2025-01-02T00:00:00Z",
                  outdated: false,
                },
              ],
            },
          ],
          sections: [],
          categories: [],
          meta: { has_more: false },
          links: { next: null },
        }),
      (request) => {
        expect(request.url).toContain("/help_center/es-419/sections/40.json");
        return json({}, 404);
      },
      (request) => {
        expect(request.url).toContain("/help_center/sections/40.json");
        return json({
          section: {
            id: 40,
            locale: "en-US",
            name: "Start",
            category_id: 50,
          },
        });
      },
      (request) => {
        expect(request.url).toContain("/help_center/es-419/categories/50.json");
        return json({}, 404);
      },
      (request) => {
        expect(request.url).toContain("/help_center/categories/50.json");
        return json({
          category: { id: 50, locale: "en-US", name: "Help" },
        });
      },
    ]);

    const [record] = await listEligibleTranslations(
      client(mock.fetch),
      brand,
      "es-419",
      { limit: 1 },
    );
    expect(record).toMatchObject({
      sectionName: "Start",
      categoryName: "Help",
    });
    mock.done();
  });

  it("rejects unsafe and repeated cursor continuations", async () => {
    const unsafe = scripted([
      () =>
        json({
          brands: [],
          meta: { has_more: true },
          links: { next: "https://evil.example/api" },
        }),
    ]);
    await expect(discoverBrands(client(unsafe.fetch))).rejects.toThrow(
      /unsafe/u,
    );
    const repeated = scripted([
      () =>
        json({
          brands: [],
          meta: { has_more: true },
          links: { next: "https://account.zendesk.com/repeat" },
        }),
      () =>
        json({
          brands: [],
          meta: { has_more: true },
          links: { next: "https://account.zendesk.com/repeat" },
        }),
    ]);
    await expect(discoverBrands(client(repeated.fetch))).rejects.toThrow(
      /repeated/u,
    );
  });

  it("fails a page sequence that does not terminate within its bound", async () => {
    const mock = scripted([
      () =>
        json({
          brands: [],
          meta: { has_more: true },
          links: { next: "https://account.zendesk.com/second" },
        }),
    ]);
    await expect(
      discoverBrands(client(mock.fetch, { maxPages: 1 })),
    ).rejects.toThrow(/did not terminate/u);
    mock.done();
  });

  it("stops on has_more false without following an unused continuation", async () => {
    const terminal = scripted([
      () =>
        json({
          brands: [],
          meta: { has_more: false },
          links: { next: "https://account.zendesk.com/extra" },
        }),
    ]);
    await expect(discoverBrands(client(terminal.fetch))).resolves.toEqual([]);
    terminal.done();
  });

  it("rejects a malformed JSON content type", async () => {
    const invalid = scripted([
      () =>
        new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    ]);
    await expect(discoverLocales(client(invalid.fetch), brand)).rejects.toThrow(
      /invalid/u,
    );
  });

  it("retries only transient failures three times and honors bounded Retry-After", async () => {
    const sleeps: number[] = [];
    const mock = scripted([
      () => json({}, 429, { "retry-after": "999" }),
      () => json({}, 503),
      () => json({ locales: ["en-US"] }),
    ]);
    await discoverLocales(
      client(mock.fetch, {
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      }),
      brand,
    );
    expect(sleeps).toEqual([300_000, 8_000]);
    const permanent = scripted([() => json({}, 401)]);
    await expect(
      discoverLocales(client(permanent.fetch), brand),
    ).rejects.toThrow(/request failed/u);
    expect(permanent.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails incomplete source records instead of skipping them", async () => {
    const mock = scripted([
      () =>
        json({
          articles: [
            {
              id: 20,
              draft: false,
              archived: false,
              user_segment_ids: [],
              user_segment_id: null,
              locale: "en-US",
              created_at: "2025-01-01T00:00:00Z",
              section_id: 40,
              label_names: [],
              promoted: false,
              translations: [
                {
                  id: 30,
                  locale: "en-US",
                  draft: false,
                  title: "Hello",
                  body: "Body",
                  html_url: "https://docs.example/a",
                  updated_at: "2025-01-02T00:00:00Z",
                  outdated: false,
                },
              ],
            },
          ],
          sections: [],
          categories: [],
          meta: { has_more: false },
          links: { next: null },
        }),
      () =>
        json({
          section: {
            id: 40,
            locale: "en-US",
            name: "Start",
          },
        }),
    ]);
    await expect(
      listEligibleTranslations(client(mock.fetch), brand, "en-US"),
    ).rejects.toThrow(/category id must be a decimal string/u);
    mock.done();
  });

  it("reports an isolated record defect after stable source identity is known", async () => {
    const mock = scripted([
      () =>
        json({
          articles: [
            {
              id: 20,
              draft: false,
              archived: false,
              user_segment_ids: [],
              user_segment_id: null,
              locale: "en-US",
              created_at: "2025-01-01T00:00:00Z",
              section_id: 40,
              label_names: [],
              promoted: false,
              translations: [
                {
                  id: 30,
                  locale: "en-US",
                  draft: false,
                  title: "Public title",
                  body: "Body",
                  html_url: "https://docs.example/a",
                  updated_at: "2025-01-02T00:00:00Z",
                  outdated: false,
                },
              ],
            },
          ],
          sections: [],
          categories: [],
          meta: { has_more: false },
          links: { next: null },
        }),
      () =>
        json({
          section: {
            id: 40,
            locale: "en-US",
            name: "Start",
          },
        }),
    ]);
    const quarantined: unknown[] = [];

    await expect(
      listEligibleTranslations(client(mock.fetch), brand, "en-US", {
        onQuarantine: (record) => quarantined.push(record),
      }),
    ).resolves.toEqual([]);
    expect(quarantined).toEqual([
      {
        articleId: "20",
        locale: "en_us",
        publicTitle: "Public title",
        publicUrl: "https://docs.example/a",
        reasonCode: "INVALID_SOURCE_RECORD",
      },
    ]);
    mock.done();
  });

  it("rejects malformed visibility metadata instead of treating it as public", async () => {
    const mock = scripted([
      () =>
        json({
          articles: [
            {
              id: 20,
              locale: "en-US",
              draft: false,
              archived: false,
              user_segment_ids: "not-an-array",
              section_id: 40,
              label_names: [],
              promoted: false,
              created_at: "2025-01-01T00:00:00Z",
            },
          ],
          sections: [],
          categories: [],
          meta: { has_more: false },
          links: { next: null },
        }),
    ]);
    await expect(
      listEligibleTranslations(client(mock.fetch), brand, "en-US"),
    ).rejects.toThrow(/segment list was invalid/u);
    mock.done();
  });
});
