import { describe, expect, it, vi } from "vitest";

import {
  assertConnectorKeyAvailable,
  createUpsertBatches,
  deleteExactIds,
  isSearchStaxUndefinedFieldError,
  listOwnedIds,
  listZendeskCandidates,
  readinessProbe,
  searchStaxFieldMatches,
  selectExactId,
  serializeUpsert,
  upsert,
  waitForOwnedIdParity,
  waitForSampledFields,
  type SearchStaxCandidateUrlField,
  type PendingProbeStore,
  type SearchStaxClient,
} from "./searchstax.ts";
import type { PreparedRecord } from "./record.ts";

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
  changed: Partial<SearchStaxClient> = {},
): SearchStaxClient {
  return {
    settings: {
      updateEndpoint: "https://app.searchstax.com/api/update/json/docs",
      selectEndpoint: "https://app.searchstax.com/api/select",
      token: "secret",
    },
    fetch,
    sleep: vi.fn(async () => undefined),
    ...changed,
  };
}

function prepared(id = "zdg_docs_1_en", body = "Body"): PreparedRecord {
  const document = { id, body_text_txt_en: body };
  const canonical = JSON.stringify(document);
  return {
    id,
    document,
    canonical,
    hash: "abc",
    byteSize: new TextEncoder().encode(canonical).byteLength,
    warnings: [],
  };
}

describe("SearchStax destination contract", () => {
  it("accepts an omitted empty deterministic body field but not stale or nonempty values", () => {
    expect(searchStaxFieldMatches("body_text_txt_en", undefined, "")).toBe(
      true,
    );
    expect(searchStaxFieldMatches("body_text_txt_en", undefined, "Body")).toBe(
      false,
    );
    expect(searchStaxFieldMatches("body_text_txt_en", "stale", "")).toBe(false);
    expect(searchStaxFieldMatches("title_txt_en", undefined, "")).toBe(false);
  });

  it("validates HTTPS endpoints and accepted update suffixes", async () => {
    const none = scripted([]);
    await expect(
      upsert(
        client(none.fetch, {
          settings: {
            updateEndpoint: "http://unsafe/api/update",
            selectEndpoint: "https://app.searchstax.com/api/select",
            token: "x",
          },
        }),
        serializeUpsert([prepared()]),
      ),
    ).rejects.toThrow(/invalid/u);
    await expect(
      upsert(
        client(none.fetch, {
          settings: {
            updateEndpoint: "https://app.searchstax.com/api/other",
            selectEndpoint: "https://app.searchstax.com/api/select",
            token: "x",
          },
        }),
        serializeUpsert([prepared()]),
      ),
    ).rejects.toThrow(/invalid/u);
  });

  it("refuses cross-origin update and select endpoints before sending credentials", async () => {
    const fetch = vi.fn(async () =>
      json({ responseHeader: { status: 0 } }),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      upsert(
        client(fetch, {
          settings: {
            updateEndpoint: "https://write.searchstax.com/api/update",
            selectEndpoint: "https://read.searchstax.com/api/select",
            token: "secret",
          },
        }),
        serializeUpsert([prepared()]),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes copied emselect query endpoints to select", async () => {
    for (const suffix of ["select", "emselect"]) {
      const mock = scripted([
        (request) => {
          expect(new URL(request.url).pathname).toBe("/api/select");
          return json({
            responseHeader: { status: 0 },
            response: { numFound: 0, docs: [] },
          });
        },
      ]);
      await expect(
        selectExactId(
          client(mock.fetch, {
            settings: {
              updateEndpoint: "https://app.searchstax.com/api/update/json/docs",
              selectEndpoint: `https://app.searchstax.com/api/${suffix}`,
              token: "secret",
            },
          }),
          "zdg_docs_1_en",
        ),
      ).resolves.toBeNull();
      mock.done();
    }
  });

  it("writes deterministic JSON arrays and requires the exact acknowledgement", async () => {
    const mock = scripted([
      (request) => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe(
          "https://app.searchstax.com/api/update/json/docs?commit=true",
        );
        expect(request.headers.get("authorization")).toBe("Token secret");
        expect(request.headers.get("content-type")).toBe("application/json");
        return json({ responseHeader: { status: 0 } });
      },
    ]);
    await upsert(client(mock.fetch), serializeUpsert([prepared()]), true);
    mock.done();
    for (const response of [
      json({ responseHeader: { status: 1 } }),
      new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
      json({}, 202),
    ]) {
      const failed = scripted([() => response]);
      await expect(
        upsert(client(failed.fetch), serializeUpsert([prepared()])),
      ).rejects.toThrow();
    }
  });

  it("refuses redirected responses", async () => {
    const response = json({ responseHeader: { status: 0 } });
    Object.defineProperty(response, "redirected", { value: true });
    const mock = scripted([() => response]);
    await expect(
      upsert(client(mock.fetch), serializeUpsert([prepared()])),
    ).rejects.toThrow(/redirect/u);
  });

  it("retries 429 and 5xx only, then reports exhaustion", async () => {
    const sleeps: number[] = [];
    const mock = scripted([
      () => json({}, 429, { "retry-after": "1" }),
      () => json({}, 503),
      () => json({ responseHeader: { status: 0 } }),
    ]);
    await upsert(
      client(mock.fetch, {
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      }),
      serializeUpsert([prepared()]),
    );
    expect(sleeps).toEqual([1_000, 8_000]);
    const exhausted = scripted([
      () => json({}, 500),
      () => json({}, 500),
      () => json({}, 500),
    ]);
    await expect(
      upsert(client(exhausted.fetch), serializeUpsert([prepared()])),
    ).rejects.toThrow(/request failed/u);
    const permanent = scripted([() => json({}, 400)]);
    await expect(
      upsert(client(permanent.fetch), serializeUpsert([prepared()])),
    ).rejects.toThrow(/request failed/u);
    expect(permanent.fetch).toHaveBeenCalledTimes(1);
  });

  it("measures UTF-8 array envelopes and splits strictly below 2 MiB", () => {
    const large = "😀".repeat(280_000);
    const batches = createUpsertBatches([
      prepared("zdg_docs_1_en", large),
      prepared("zdg_docs_2_en", large),
    ]);
    expect(batches).toHaveLength(2);
    expect(batches.every((batch) => batch.byteSize < 2_097_152)).toBe(true);
    expect(batches[0]!.byteSize).toBe(
      new TextEncoder().encode(batches[0]!.body).byteLength,
    );
    expect(() =>
      createUpsertBatches([prepared("zdg_docs_1_en", "😀".repeat(530_000))]),
    ).toThrow(/exceeded/u);
  });

  it("deletes only validated exact connector or probe IDs through the query endpoint", async () => {
    const mock = scripted([
      (request) => {
        expect(request.url).toBe(
          "https://app.searchstax.com/api/update?commit=true",
        );
        return request.text().then((body) => {
          expect(body).toBe(
            '{"delete":{"query":"id:\\"zdg_docs_1_en\\" OR id:\\"zdg_docs_2_en\\""}}',
          );
          return json({ responseHeader: { status: 0 } });
        });
      },
    ]);
    await deleteExactIds(client(mock.fetch), [
      "zdg_docs_2_en",
      "zdg_docs_1_en",
    ]);
    mock.done();
    for (const ids of [
      [],
      ["*:*"],
      ["caller-supplied"],
      ["zdg_docs_1_en", "zdg_docs_1_en"],
    ]) {
      await expect(
        deleteExactIds(client(scripted([]).fetch), ids),
      ).rejects.toThrow(/invalid/u);
    }
  });

  it("queries exact escaped IDs and rejects ambiguous results", async () => {
    const mock = scripted([
      (request) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("q")).toBe('id:"zdg_docs_1_en"');
        expect(url.searchParams.get("rows")).toBe("2");
        return json({
          responseHeader: { status: 0 },
          response: { numFound: 1, docs: [{ id: "zdg_docs_1_en" }] },
        });
      },
    ]);
    await expect(
      selectExactId(client(mock.fetch), "zdg_docs_1_en"),
    ).resolves.toEqual({ id: "zdg_docs_1_en" });
    const ambiguous = scripted([
      () =>
        json({
          responseHeader: { status: 0 },
          response: { numFound: 2, docs: [{}, {}] },
        }),
    ]);
    await expect(
      selectExactId(client(ambiguous.fetch), "zdg_docs_1_en"),
    ).rejects.toThrow(/not exact/u);
  });

  it("rejects connector-key ownership outside the current manifest", async () => {
    const conflict = scripted([
      (request) => {
        expect(new URL(request.url).searchParams.get("q")).toBe(
          'connector_key_s:"docs"',
        );
        return json({
          responseHeader: { status: 0 },
          response: { numFound: 1, docs: [{ id: "zdg_docs_9_en" }] },
        });
      },
    ]);
    await expect(
      assertConnectorKeyAvailable(client(conflict.fetch), "docs", new Set()),
    ).rejects.toThrow(/outside the current manifest/u);

    const owned = scripted([
      () =>
        json({
          responseHeader: { status: 0 },
          response: { numFound: 1, docs: [{ id: "zdg_docs_9_en" }] },
        }),
    ]);
    await expect(
      assertConnectorKeyAvailable(
        client(owned.fetch),
        "docs",
        new Set(["zdg_docs_9_en"]),
      ),
    ).resolves.toBeUndefined();
  });

  it("reads a single-page complete connector-owned ID inventory", async () => {
    const mock = scripted([
      (request) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("cursorMark")).toBe("*");
        return json({
          responseHeader: { status: 0 },
          response: {
            numFound: 2,
            docs: [{ id: "zdg_docs_2_en" }, { id: "zdg_docs_1_en" }],
          },
          nextCursorMark: "*",
        });
      },
    ]);

    await expect(listOwnedIds(client(mock.fetch), "docs")).resolves.toEqual([
      "zdg_docs_1_en",
      "zdg_docs_2_en",
    ]);
    mock.done();
  });

  it("reads a multi-page inventory without using an expected source count", async () => {
    const mock = scripted([
      (request) => {
        expect(new URL(request.url).searchParams.get("cursorMark")).toBe("*");
        return json({
          responseHeader: { status: 0 },
          response: {
            numFound: 3,
            docs: [{ id: "zdg_docs_1_en" }, { id: "zdg_docs_2_en" }],
          },
          nextCursorMark: "cursor-1",
        });
      },
      (request) => {
        expect(new URL(request.url).searchParams.get("cursorMark")).toBe(
          "cursor-1",
        );
        return json({
          responseHeader: { status: 0 },
          response: {
            numFound: 3,
            docs: [{ id: "zdg_docs_3_en" }],
          },
          nextCursorMark: "cursor-1",
        });
      },
    ]);

    await expect(listOwnedIds(client(mock.fetch), "docs")).resolves.toEqual([
      "zdg_docs_1_en",
      "zdg_docs_2_en",
      "zdg_docs_3_en",
    ]);
    mock.done();
  });

  it("rejects duplicate, malformed, incomplete, and unavailable inventories", async () => {
    const cases = [
      {
        response: {
          numFound: 2,
          docs: [{ id: "zdg_docs_1_en" }, { id: "zdg_docs_1_en" }],
        },
        nextCursorMark: "*",
      },
      {
        response: { numFound: 1, docs: [{ id: 1 }] },
        nextCursorMark: "*",
      },
      {
        response: { numFound: 2, docs: [{ id: "zdg_docs_1_en" }] },
        nextCursorMark: "*",
      },
    ];
    for (const body of cases) {
      const mock = scripted([
        () => json({ responseHeader: { status: 0 }, ...body }),
      ]);
      await expect(
        listOwnedIds(client(mock.fetch), "docs"),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }

    const unavailable = scripted([() => json({}, 400)]);
    await expect(
      listOwnedIds(client(unavailable.fetch), "docs"),
    ).rejects.toMatchObject({ code: "PERMANENT_HTTP_FAILURE" });
  });

  it("discovers candidates with complete per-field cursor pages and ID deduplication", async () => {
    const checkpoint = vi.fn(async () => undefined);
    const mock = scripted([
      (request) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("q")).toBe("url:*docs.zendesk.com*");
        expect(url.searchParams.get("fl")).toBe("id,url");
        expect(url.searchParams.get("cursorMark")).toBe("*");
        return json({
          responseHeader: { status: 0 },
          response: {
            numFound: 2,
            docs: [
              {
                id: "legacy-1",
                url: "https://docs.zendesk.com/hc/en-us/articles/1-old",
              },
            ],
          },
          nextCursorMark: "cursor-1",
        });
      },
      (request) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("q")).toBe("url:*docs.zendesk.com*");
        expect(url.searchParams.get("cursorMark")).toBe("cursor-1");
        return json({
          responseHeader: { status: 0 },
          response: {
            numFound: 2,
            docs: [
              {
                id: "legacy-2",
                url: "https://docs.zendesk.com/hc/en-us/articles/2",
              },
            ],
          },
          nextCursorMark: "cursor-2",
        });
      },
      (request) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("q")).toBe("url_s:*docs.zendesk.com*");
        expect(url.searchParams.get("fl")).toBe("id,url_s");
        return json({
          responseHeader: { status: 0 },
          response: {
            numFound: 1,
            docs: [
              {
                id: "legacy-1",
                url_s: "https://docs.zendesk.com/hc/en-us/articles/1-old",
              },
            ],
          },
          nextCursorMark: "*",
        });
      },
      (request) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("q")).toBe("ss_url:*docs.zendesk.com*");
        expect(url.searchParams.get("fl")).toBe("id,ss_url");
        return json({
          responseHeader: { status: 0 },
          response: {
            numFound: 1,
            docs: [
              {
                id: "legacy-2",
                ss_url: "https://docs.zendesk.com/hc/en-us/articles/2",
              },
            ],
          },
          nextCursorMark: "*",
        });
      },
    ]);
    await expect(
      listZendeskCandidates(client(mock.fetch), "Docs", 5_000, checkpoint),
    ).resolves.toEqual({
      candidates: [
        {
          id: "legacy-1",
          document: {
            id: "legacy-1",
            url: "https://docs.zendesk.com/hc/en-us/articles/1-old",
            url_s: "https://docs.zendesk.com/hc/en-us/articles/1-old",
          },
        },
        {
          id: "legacy-2",
          document: {
            id: "legacy-2",
            url: "https://docs.zendesk.com/hc/en-us/articles/2",
            ss_url: "https://docs.zendesk.com/hc/en-us/articles/2",
          },
        },
      ],
      fieldAvailability: {
        url: { state: "queryable" },
        url_s: { state: "queryable" },
        ss_url: { state: "queryable" },
      },
    });
    expect(checkpoint).toHaveBeenCalledTimes(4);
    mock.done();
  });

  it("queries the canonical and authenticated source URL hosts", async () => {
    const mock = scripted(
      (["url", "url_s", "ss_url"] as const).map((field) => (request) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("q")).toBe(
          `${field}:*docs.zendesk.com* OR ${field}:*support.example.com*`,
        );
        return json({
          responseHeader: { status: 0 },
          response: { numFound: 0, docs: [] },
          nextCursorMark: "*",
        });
      }),
    );
    await expect(
      listZendeskCandidates(client(mock.fetch), "docs", 5_000, undefined, [
        "https://support.example.com/hc/en-us/articles/30",
        "https://SUPPORT.example.com/hc/en-us/articles/31",
        "https://*.example.com/hc/en-us/articles/32",
        "https://[::1]/hc/en-us/articles/33",
        "https://user:password@ignored.example.com/article",
        "http://ignored.example.com/article",
      ]),
    ).resolves.toMatchObject({ candidates: [] });
    mock.done();
  });

  it("continues when one supported field is explicitly undefined", async () => {
    const fields: readonly SearchStaxCandidateUrlField[] = [
      "url",
      "url_s",
      "ss_url",
    ];
    for (const missing of fields) {
      const mock = scripted(
        fields.map((field) => (request) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("q")).toBe(`${field}:*docs.zendesk.com*`);
          if (field === missing)
            return json(
              {
                responseHeader: { status: 400 },
                error: { code: 400, msg: `undefined field: ${field}` },
              },
              400,
            );
          return json({
            responseHeader: { status: 0 },
            response: {
              numFound: 1,
              docs: [
                {
                  id: `${field}-id`,
                  [field]: `https://docs.zendesk.com/hc/en-us/articles/${field}`,
                },
              ],
            },
            nextCursorMark: "*",
          });
        }),
      );
      const result = await listZendeskCandidates(client(mock.fetch), "docs");
      expect(result.candidates.map((item) => item.id)).toEqual(
        fields
          .filter((field) => field !== missing)
          .map((field) => `${field}-id`)
          .sort((left, right) => left.localeCompare(right)),
      );
      expect(result.fieldAvailability[missing]).toEqual({
        state: "unavailable",
        reasonCode: "UNDEFINED_FIELD",
      });
      mock.done();
    }
  });

  it("continues with one queryable field when two supported fields are undefined", async () => {
    const mock = scripted([
      (request) => {
        expect(new URL(request.url).searchParams.get("q")).toBe(
          "url:*docs.zendesk.com*",
        );
        return json(
          {
            responseHeader: { status: 400 },
            error: { code: 400, msg: "undefined field: url" },
          },
          400,
        );
      },
      (request) => {
        expect(new URL(request.url).searchParams.get("q")).toBe(
          "url_s:*docs.zendesk.com*",
        );
        return json(
          {
            responseHeader: { status: 400 },
            error: { code: 400, msg: "undefined field: url_s" },
          },
          400,
        );
      },
      () =>
        json({
          responseHeader: { status: 0 },
          response: {
            numFound: 1,
            docs: [
              {
                id: "legacy-1",
                ss_url: "https://docs.zendesk.com/hc/en-us/articles/1",
              },
            ],
          },
          nextCursorMark: "*",
        }),
    ]);
    await expect(
      listZendeskCandidates(client(mock.fetch), "docs"),
    ).resolves.toMatchObject({
      candidates: [{ id: "legacy-1" }],
      fieldAvailability: {
        url: { state: "unavailable", reasonCode: "UNDEFINED_FIELD" },
        url_s: { state: "unavailable", reasonCode: "UNDEFINED_FIELD" },
        ss_url: { state: "queryable" },
      },
    });
    mock.done();
  });

  it("fails closed when all supported fields are explicitly undefined", async () => {
    const mock = scripted(
      ["url", "url_s", "ss_url"].map(
        (field) => () =>
          json(
            {
              responseHeader: { status: 400 },
              error: { code: 400, msg: `undefined field: ${field}` },
            },
            400,
          ),
      ),
    );
    await expect(
      listZendeskCandidates(client(mock.fetch), "docs"),
    ).rejects.toMatchObject({ code: "NO_SUPPORTED_URL_FIELD" });
    mock.done();
  });

  it("does not classify unknown 400 responses as missing fields", async () => {
    const mock = scripted([
      () =>
        json(
          {
            responseHeader: { status: 400 },
            error: { code: 400, msg: "undefined field: another_field" },
          },
          400,
        ),
    ]);
    await expect(
      listZendeskCandidates(client(mock.fetch), "docs"),
    ).rejects.toMatchObject({ code: "PERMANENT_HTTP_FAILURE" });
    mock.done();
  });

  it("preserves failures for auth, vendor, malformed, and cursor responses", async () => {
    const cases = [
      {
        responses: [json({}, 401)],
        code: "PERMANENT_HTTP_FAILURE",
      },
      {
        responses: [json({}, 500), json({}, 500), json({}, 500)],
        code: "TRANSIENT_HTTP_FAILURE",
      },
      {
        responses: [json({ responseHeader: { status: 0 }, response: {} })],
        code: "INVALID_RESPONSE",
      },
      {
        responses: [
          json({
            responseHeader: { status: 0 },
            response: { numFound: 2, docs: [{ id: "legacy-1" }] },
            nextCursorMark: "*",
          }),
        ],
        code: "INVALID_RESPONSE",
      },
    ] as const;
    for (const testCase of cases) {
      const mock = scripted(
        testCase.responses.map((response) => () => response),
      );
      await expect(
        listZendeskCandidates(
          client(mock.fetch, { sleep: vi.fn(async () => undefined) }),
          "docs",
        ),
      ).rejects.toMatchObject({ code: testCase.code });
      mock.done();
    }
  });

  it("classifies only the exact structured undefined-field response", () => {
    expect(
      isSearchStaxUndefinedFieldError(
        {
          responseHeader: { status: 400 },
          error: { code: 400, msg: "undefined field: ss_url" },
        },
        "ss_url",
      ),
    ).toBe(true);
    expect(
      isSearchStaxUndefinedFieldError(
        {
          responseHeader: { status: 400 },
          error: { code: 400, msg: "undefined field ss_url" },
        },
        "ss_url",
      ),
    ).toBe(true);
    expect(
      isSearchStaxUndefinedFieldError(
        {
          responseHeader: { status: 400 },
          error: { code: 400, msg: "undefined field: url" },
        },
        "ss_url",
      ),
    ).toBe(false);
    expect(
      isSearchStaxUndefinedFieldError(
        { error: "undefined field: ss_url" },
        "ss_url",
      ),
    ).toBe(false);
  });

  it("fails closed when candidate pagination cannot be completed", async () => {
    const mock = scripted([
      () =>
        json({
          responseHeader: { status: 0 },
          response: { numFound: 2, docs: [{ id: "legacy-1" }] },
          nextCursorMark: "*",
        }),
    ]);
    await expect(
      listZendeskCandidates(client(mock.fetch), "docs"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    mock.done();
  });

  it("reads the complete connector-owned ID set through stable cursor pages", async () => {
    const checkpoint = vi.fn(async () => undefined);
    const mock = scripted([
      (request) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("q")).toBe('connector_key_s:"docs"');
        expect(url.searchParams.get("fl")).toBe("id");
        expect(url.searchParams.get("rows")).toBe("500");
        expect(url.searchParams.get("sort")).toBe("id asc");
        expect(url.searchParams.get("cursorMark")).toBe("*");
        return json({
          responseHeader: { status: 0 },
          response: { numFound: 2, docs: [{ id: "zdg_docs_1_en" }] },
          nextCursorMark: "cursor-1",
        });
      },
      (request) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("cursorMark")).toBe("cursor-1");
        return json({
          responseHeader: { status: 0 },
          response: { numFound: 2, docs: [{ id: "zdg_docs_2_en" }] },
          nextCursorMark: "cursor-1",
        });
      },
    ]);

    await waitForOwnedIdParity(
      client(mock.fetch),
      "docs",
      ["zdg_docs_2_en", "zdg_docs_1_en"],
      checkpoint,
    );

    expect(checkpoint).toHaveBeenCalledTimes(2);
    mock.done();
  });

  it("rejects repeated cursors, count drift, and incomplete terminal pages", async () => {
    const cases = [
      [
        { numFound: 3, docs: [{ id: "zdg_docs_1_en" }], next: "a" },
        { numFound: 3, docs: [{ id: "zdg_docs_2_en" }], next: "b" },
        { numFound: 3, docs: [], next: "a" },
      ],
      [
        { numFound: 2, docs: [{ id: "zdg_docs_1_en" }], next: "a" },
        { numFound: 1, docs: [{ id: "zdg_docs_2_en" }], next: "a" },
      ],
      [{ numFound: 2, docs: [{ id: "zdg_docs_1_en" }], next: "*" }],
    ] as const;

    for (const pages of cases) {
      const mock = scripted(
        pages.map(
          (page) => () =>
            json({
              responseHeader: { status: 0 },
              response: { numFound: page.numFound, docs: page.docs },
              nextCursorMark: page.next,
            }),
        ),
      );
      await expect(
        waitForOwnedIdParity(
          client(mock.fetch, { visibilityMaxAttempts: 1 }),
          "docs",
          Array.from(
            { length: pages[0].numFound },
            (_, index) => `zdg_docs_${index + 1}_en`,
          ),
        ),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });

  it("polls until the bounded connector-owned ID set exactly matches", async () => {
    const sleeps: number[] = [];
    const mock = scripted([
      (request) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("q")).toBe('connector_key_s:"docs"');
        expect(url.searchParams.get("fl")).toBe("id");
        expect(url.searchParams.get("rows")).toBe("500");
        return json({
          responseHeader: { status: 0 },
          response: { numFound: 1, docs: [{ id: "zdg_docs_1_en" }] },
          nextCursorMark: "*",
        });
      },
      () =>
        json({
          responseHeader: { status: 0 },
          response: {
            numFound: 2,
            docs: [{ id: "zdg_docs_2_en" }, { id: "zdg_docs_1_en" }],
          },
          nextCursorMark: "*",
        }),
    ]);

    await waitForOwnedIdParity(
      client(mock.fetch, {
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      }),
      "docs",
      ["zdg_docs_1_en", "zdg_docs_2_en"],
    );

    expect(sleeps).toEqual([15_000]);
    mock.done();
  });

  it("fails mismatched or malformed bounded ownership results with safe codes", async () => {
    const mismatch = scripted([
      () =>
        json({
          responseHeader: { status: 0 },
          response: { numFound: 1, docs: [{ id: "zdg_docs_9_en" }] },
          nextCursorMark: "*",
        }),
    ]);
    await expect(
      waitForOwnedIdParity(
        client(mismatch.fetch, { visibilityMaxAttempts: 1 }),
        "docs",
        ["zdg_docs_1_en"],
      ),
    ).rejects.toMatchObject({ code: "DESTINATION_PARITY_MISMATCH" });

    const extraCount = scripted([
      () =>
        json({
          responseHeader: { status: 0 },
          response: { numFound: 2, docs: [{ id: "zdg_docs_1_en" }] },
          nextCursorMark: "*",
        }),
    ]);
    await expect(
      waitForOwnedIdParity(
        client(extraCount.fetch, { visibilityMaxAttempts: 1 }),
        "docs",
        ["zdg_docs_1_en"],
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    for (const response of [
      { numFound: 2, docs: [{ id: "zdg_docs_1_en" }, { id: "zdg_docs_1_en" }] },
      { numFound: 1, docs: [{ id: 1 }] },
      {
        numFound: 5_001,
        docs: Array.from({ length: 5_001 }, (_, index) => ({
          id: `zdg_docs_${index}_en`,
        })),
      },
    ]) {
      const malformed = scripted([
        () => json({ responseHeader: { status: 0 }, response }),
      ]);
      await expect(
        waitForOwnedIdParity(
          client(malformed.fetch, { visibilityMaxAttempts: 1 }),
          "docs",
          ["zdg_docs_1_en"],
        ),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });

  it("verifies every expected field on a written record after owned-ID parity", async () => {
    const changed = prepared("zdg_docs_1_en", "Changed body");
    const mock = scripted([
      (request) => {
        expect(new URL(request.url).searchParams.get("q")).toBe(
          `id:"${changed.id}"`,
        );
        return json({
          responseHeader: { status: 0 },
          response: { numFound: 1, docs: [changed.document] },
        });
      },
    ]);

    await waitForSampledFields(client(mock.fetch), [changed]);

    mock.done();
  });

  it("retries sampled fields until they converge", async () => {
    const sleeps: number[] = [];
    const changed = prepared("zdg_docs_1_en", "Expected body");
    const selected = (body: string) =>
      json({
        responseHeader: { status: 0 },
        response: {
          numFound: 1,
          docs: [{ ...changed.document, body_text_txt_en: body }],
        },
      });
    const mock = scripted([
      () => selected("Stale body"),
      () => selected("Expected body"),
    ]);

    await waitForSampledFields(
      client(mock.fetch, {
        visibilityMaxAttempts: 2,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      }),
      [changed],
    );

    expect(sleeps).toEqual([15_000]);
    mock.done();
  });

  it("selects the first 20 records by stable ID and accepts field equivalence", async () => {
    const records = Array.from({ length: 21 }, (_, index) =>
      prepared(`zdg_docs_${index + 1}_en`, `Body ${index + 1}`),
    );
    records[0]!.document.created_at_dt = "2026-08-08T00:00:00.000Z";
    records[0]!.document.label_names_ss = [];
    const sample = [...records]
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, 20);
    const checkpoint = vi.fn(async () => undefined);
    const mock = scripted(
      sample.map((expected) => (request) => {
        expect(new URL(request.url).searchParams.get("q")).toBe(
          `id:"${expected.id}"`,
        );
        const document: Record<string, unknown> = {
          ...expected.document,
          destination_only_s: "ignored",
        };
        if (expected === records[0]) {
          document.created_at_dt = "2026-08-07T19:00:00-05:00";
          delete document.label_names_ss;
        }
        return json({
          responseHeader: { status: 0 },
          response: { numFound: 1, docs: [document] },
        });
      }),
    );

    await waitForSampledFields(client(mock.fetch), records, checkpoint);
    await waitForSampledFields(client(scripted([]).fetch), []);

    expect(checkpoint).toHaveBeenCalledTimes(20);
    mock.done();
  });

  it("fails missing or stale sampled fields with a stable safe code", async () => {
    const expected = prepared();
    for (const response of [
      { numFound: 0, docs: [] },
      {
        numFound: 1,
        docs: [{ ...expected.document, body_text_txt_en: "stale" }],
      },
    ]) {
      const mock = scripted([
        () => json({ responseHeader: { status: 0 }, response }),
      ]);
      await expect(
        waitForSampledFields(client(mock.fetch, { visibilityMaxAttempts: 1 }), [
          expected,
        ]),
      ).rejects.toMatchObject({ code: "DESTINATION_FIELD_MISMATCH" });
    }
  });

  it("allows ten minutes each for query-visible write and cleanup", async () => {
    let now = 0;
    let writtenDocument: Record<string, unknown> | undefined;
    let deleting = false;
    let writeReads = 0;
    let cleanupReads = 0;
    let pending: string | null = null;
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as
            Record<string, unknown>[] | { delete: string[] };
          if (Array.isArray(body)) writtenDocument = body[0];
          else deleting = true;
          return json({ responseHeader: { status: 0 } });
        }
        expect(
          new URL(input instanceof Request ? input.url : input).pathname,
        ).toBe("/api/select");
        if (!deleting) {
          writeReads += 1;
          const visible = writeReads === 41;
          return json({
            responseHeader: { status: 0 },
            response: {
              numFound: visible ? 1 : 0,
              docs: visible ? [writtenDocument] : [],
            },
          });
        }
        cleanupReads += 1;
        const absent = cleanupReads === 41;
        return json({
          responseHeader: { status: 0 },
          response: {
            numFound: absent ? 0 : 1,
            docs: absent ? [] : [writtenDocument],
          },
        });
      },
    ) as unknown as typeof globalThis.fetch;

    await readinessProbe(
      client(fetch, {
        now: () => now,
        deadlineAt: 10 * 60 * 1_000 + 10_000,
        cleanupDeadlineAt: 20 * 60 * 1_000 + 20_000,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      }),
      {
        get: async () => pending,
        set: async (id) => {
          pending = id;
        },
        clear: async (id) => {
          if (pending === id) pending = null;
        },
      },
      () => "fixed",
    );

    expect(now).toBe(20 * 60 * 1_000);
    expect(writeReads).toBe(41);
    expect(cleanupReads).toBe(41);
    expect(pending).toBeNull();
  });

  it("reports exhausted write visibility after confirmed cleanup", async () => {
    let now = 0;
    let pending: string | null = null;
    let written: Record<string, unknown> | undefined;
    const phases: string[] = [];
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as
            Record<string, unknown>[] | { delete: string[] };
          if (Array.isArray(body)) written = body[0];
          return json({ responseHeader: { status: 0 } });
        }
        return json({
          responseHeader: { status: 0 },
          response: { numFound: 0, docs: [] },
        });
      },
    ) as unknown as typeof globalThis.fetch;
    const bounded = client(fetch, {
      now: () => now,
      deadlineAt: 45_000,
      cleanupDeadlineAt: 60_000,
      visibilityMaxAttempts: 1,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await expect(
      readinessProbe(
        bounded,
        {
          get: async () => pending,
          set: async (id) => {
            pending = id;
          },
          clear: async (id) => {
            if (pending === id) pending = null;
          },
        },
        () => "fixed",
        (phase) => phases.push(phase),
      ),
    ).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });

    expect(now).toBeLessThanOrEqual(60_000);
    expect(written?.id).toBe("zdg_probe_fixed");
    expect(pending).toBeNull();
    expect(phases).toEqual([
      "writing",
      "waiting_for_visibility",
      "deleting",
      "confirming_cleanup",
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("cleans an incompatible query-visible probe before reporting failure", async () => {
    let pending: string | null = null;
    let writtenDocument: Record<string, unknown> | undefined;
    const mock = scripted([
      (request) =>
        request.text().then((body) => {
          writtenDocument = (JSON.parse(body) as Record<string, unknown>[])[0]!;
          return json({ responseHeader: { status: 0 } });
        }),
      () =>
        json({
          responseHeader: { status: 0 },
          response: {
            numFound: 1,
            docs: [{ ...writtenDocument, source_system_s: "incompatible" }],
          },
        }),
      () => json({ responseHeader: { status: 0 } }),
      () =>
        json({
          responseHeader: { status: 0 },
          response: { numFound: 0, docs: [] },
        }),
    ]);

    await expect(
      readinessProbe(
        client(mock.fetch),
        {
          get: async () => pending,
          set: async (id) => {
            pending = id;
          },
          clear: async (id) => {
            if (pending === id) pending = null;
          },
        },
        () => "fixed",
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    expect(pending).toBeNull();
    mock.done();
  });

  it("blocks a new probe when persisted cleanup remains uncertain", async () => {
    const id = "zdg_probe_old";
    const store: PendingProbeStore = {
      get: async () => id,
      set: vi.fn(),
      clear: vi.fn(),
    };
    const mock = scripted([
      () => json({ responseHeader: { status: 0 } }),
      () =>
        json({
          responseHeader: { status: 0 },
          response: { numFound: 1, docs: [{ id }] },
        }),
    ]);
    await expect(
      readinessProbe(client(mock.fetch, { visibilityMaxAttempts: 1 }), store),
    ).rejects.toThrow(/not confirmed/u);
    expect(store.set).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
    mock.done();
  });

  it("retains the exact pending row when post-write cleanup is uncertain", async () => {
    let pending: string | null = null;
    const store: PendingProbeStore = {
      get: async () => pending,
      set: async (id) => {
        pending = id;
      },
      clear: async (id) => {
        if (pending === id) pending = null;
      },
    };
    const mock = scripted([
      () => json({ responseHeader: { status: 0 } }),
      () =>
        json({
          responseHeader: { status: 0 },
          response: { numFound: 0, docs: [] },
        }),
      () => json({ responseHeader: { status: 0 } }),
      () =>
        json({
          responseHeader: { status: 0 },
          response: {
            numFound: 1,
            docs: [{ id: "zdg_probe_fixed" }],
          },
        }),
    ]);

    await expect(
      readinessProbe(
        client(mock.fetch, { visibilityMaxAttempts: 1 }),
        store,
        () => "fixed",
      ),
    ).rejects.toMatchObject({ code: "PROBE_CLEANUP_UNCERTAIN" });
    expect(pending).toBe("zdg_probe_fixed");
    mock.done();
  });
});
